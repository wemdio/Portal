"""New bank / USDT receipts → PolzaSiteFeedbackBot, without replaying history.

Only sendMessage/getMe: the bot's webhook belongs to the existing lead service.
Telegram has no idempotency key. Ambiguous sends are quarantined for manual
review instead of replayed after a timeout or process restart.
"""
from __future__ import annotations

import html
import json
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from time import monotonic

import asyncpg
import httpx

from alerts import send_worker_alert
from sources.crypto_usdt import USDT_TRC20_CONTRACT

MSK = timezone(timedelta(hours=3))
LOCK_NAMESPACE = 726462
DELIVERY_LOCK = 3
EXPECTED_BOT = "PolzaSiteFeedbackBot"


@dataclass(frozen=True)
class IncomeConfig:
    token: str
    chat_id: int
    thread_id: int


def income_config() -> IncomeConfig | None:
    if os.environ.get("BANK_INCOME_NOTIFICATIONS_ENABLED", "false").strip().lower() != "true":
        return None
    token = (os.environ.get("BANK_INCOME_TELEGRAM_BOT_TOKEN")
             or os.environ.get("SENDER_LEADS_TELEGRAM_BOT_TOKEN") or "").strip()
    chat = int(os.environ.get("BANK_INCOME_TELEGRAM_CHAT_ID", "-1001852890744"))
    thread = int(os.environ.get("BANK_INCOME_TELEGRAM_THREAD_ID", "29718"))
    if not token or chat >= 0 or thread <= 0:
        raise ValueError("Для уведомлений оплат нужны токен бота, ID группы и ID ветки")
    return IncomeConfig(token, chat, thread)


def recent_bank_periods(now: datetime) -> list[tuple[str, str]]:
    day = now.astimezone(MSK).date()
    # Overlap tolerates delays/corrections in bank statements. Full historical
    # reconciliation continues on the existing five daily runs.
    return [((day - timedelta(days=3)).isoformat(), day.isoformat())]


def _clip(value: object, limit: int) -> str:
    text = str(value or "").strip()
    return html.escape(text[:limit] + ("…" if len(text) > limit else ""))


def _bank_time(row: dict) -> str:
    raw = row.get("raw") or {}
    if isinstance(raw, str):
        raw = json.loads(raw)
    field = "documentProcessDate" if row["bank"] == "tochka" else "date"
    stamp = str(raw.get(field) or "").strip()
    if stamp:
        try:
            value = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
            if len(stamp) == 10:
                return value.strftime("%d.%m.%Y") + " (банк не передал время)"
            if value.tzinfo:
                return value.astimezone(MSK).strftime("%d.%m.%Y %H:%M МСК")
            return value.strftime("%d.%m.%Y %H:%M") + " (часовой пояс банк не указал)"
        except ValueError:
            pass
    # The normalized timestamp alone cannot prove that the bank supplied a time.
    return row["occurred_at"].astimezone(MSK).strftime("%d.%m.%Y") + " (время не подтверждено)"


def format_income(row: dict) -> str:
    amount = f"{Decimal(str(row['amount'])):,.2f}".replace(",", " ").replace(".", ",")
    currency = "₽" if row["currency"] == "RUB" else _clip(row["currency"], 12)
    bank = {"tochka": "Точка", "tbank": "Т-Банк"}[row["bank"]]
    detected = row["created_at"].astimezone(MSK).strftime("%d.%m.%Y %H:%M МСК")
    purpose = _clip(row.get("purpose"), 1200) or "банк не указал назначение платежа"
    return "\n".join([
        "💰 <b>Поступила оплата</b>", "",
        f"<b>Плательщик:</b> {_clip(row.get('payer_name'), 240) or 'банк не указал название'}",
        f"<b>ИНН:</b> {_clip(row['payer_inn'], 12)}",
        f"<b>Сумма:</b> {amount} {currency}",
        f"<b>Банк:</b> {bank}",
        f"<b>Дата/время платежа:</b> {_bank_time(row)}",
        f"<b>Обнаружено:</b> {detected}",
        f"<b>Назначение:</b> {purpose}",
    ])


def format_crypto_income(row: dict) -> str:
    amount = f"{Decimal(str(row['amount'])):,.6f}".rstrip("0").rstrip(".")
    amount = amount.replace(",", " ").replace(".", ",")
    occurred = row["occurred_at"].astimezone(MSK).strftime("%d.%m.%Y %H:%M:%S МСК")
    detected = row["created_at"].astimezone(MSK).strftime("%d.%m.%Y %H:%M МСК")
    return "\n".join([
        "💰 <b>Поступление USDT</b>", "",
        f"<b>Сумма:</b> {amount} USDT",
        "<b>Сеть:</b> Tron (TRC-20)",
        f"<b>Дата/время перевода:</b> {occurred}",
        f"<b>Обнаружено:</b> {detected}",
        f"<b>Отправитель:</b> <code>{_clip(row['from_address'], 80)}</code>",
        f"<b>Наш кошелёк:</b> <code>{_clip(row['wallet_address'], 80)}</code>",
        f"<b>Транзакция:</b> <code>{_clip(row['transaction_id'], 128)}</code>",
        "<b>Юрлицо / назначение:</b> неизвестны по данным перевода USDT",
    ])


async def prepare_income(conn: asyncpg.Connection, config: IncomeConfig) -> None:
    # Verify the exact named bot before baselining or transmitting financial data.
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(f"https://api.telegram.org/bot{config.token}/getMe")
            data = response.json()
        if not isinstance(data, dict) or response.status_code != 200 or not data.get("ok"):
            raise ValueError("Telegram отклонил проверку бота оплат")
        result = data.get("result") or {}
        if not isinstance(result, dict) or result.get("username", "").lower() != EXPECTED_BOT.lower():
            raise ValueError("Токен уведомлений оплат принадлежит другому боту")
    except (httpx.HTTPError, ValueError) as error:
        # httpx exceptions contain the request URL, hence the secret bot token.
        raise RuntimeError(f"Проверка бота оплат не прошла ({type(error).__name__})") from None
    await conn.execute(
        """WITH bank_baseline AS (
             INSERT INTO bank_income_notification_state (id, baseline_id)
             SELECT true, coalesce(max(id), 0) FROM bank_transactions
             ON CONFLICT (id) DO NOTHING RETURNING id
           )
           INSERT INTO crypto_income_notification_state (id, baseline_id)
           SELECT true, coalesce(max(id), 0) FROM crypto_income_transfers
           ON CONFLICT (id) DO NOTHING"""
    )


# An INN of the expected length is required; crypto is not included.
ELIGIBLE = """b.bank IN ('tochka', 'tbank') AND b.direction = 'credit'
    AND b.is_revenue IS TRUE AND b.amount > 0
    AND b.payer_inn ~ '^([0-9]{10}|[0-9]{12})$'"""
CRYPTO_ELIGIBLE = f"""b.network='tron' AND b.token_contract='{USDT_TRC20_CONTRACT}'
    AND b.currency='USDT' AND b.amount > 0"""


async def _deliver(client: httpx.AsyncClient, config: IncomeConfig, text: str) -> tuple[str, int | None, int]:
    try:
        response = await client.post(
            f"https://api.telegram.org/bot{config.token}/sendMessage",
            json={"chat_id": config.chat_id, "message_thread_id": config.thread_id,
                  "text": text, "parse_mode": "HTML", "disable_web_page_preview": True},
        )
        data = response.json()
    except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout):
        # Connection was not established / acquired: no message was submitted.
        return "pending", None, 60
    except (httpx.HTTPError, ValueError):
        return "unknown", None, 0
    if response.status_code >= 500 or not isinstance(data, dict):
        return "unknown", None, 0
    result = data.get("result")
    message_id = result.get("message_id") if isinstance(result, dict) else None
    if response.status_code == 200 and data.get("ok") and isinstance(message_id, int):
        return "sent", message_id, 0
    if data.get("error_code") == 429:
        try:
            delay = int((data.get("parameters") or {}).get("retry_after", 60))
        except (TypeError, ValueError, AttributeError):
            delay = 60
        return "pending", None, max(delay, 60)
    if data.get("ok") is False:
        return "failed", None, 0
    return "unknown", None, 0


async def dispatch_income(conn: asyncpg.Connection, config: IncomeConfig) -> None:
    locked = await conn.fetchval("SELECT pg_try_advisory_lock($1, $2)", LOCK_NAMESPACE, DELIVERY_LOCK)
    if not locked:
        return
    issues: list[str] = []
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            for kind in ("bank", "crypto"):
                if not await _dispatch_queue(conn, client, config, kind, issues):
                    break
    finally:
        await conn.execute("SELECT pg_advisory_unlock($1, $2)", LOCK_NAMESPACE, DELIVERY_LOCK)
        if issues:
            await send_worker_alert(
                "bank-income", "доставка оплат требует проверки", "Проверьте ветку оплат и журнал доставки",
                {"income_events": ",".join(issues)},
            )


async def _dispatch_queue(
    conn: asyncpg.Connection, client: httpx.AsyncClient, config: IncomeConfig,
    kind: str, issues: list[str],
) -> bool:
    # SQL identifiers come exclusively from these two fixed internal definitions.
    crypto = kind == "crypto"
    journal = "crypto_income_notifications" if crypto else "bank_income_notifications"
    source = "crypto_income_transfers" if crypto else "bank_transactions"
    state = "crypto_income_notification_state" if crypto else "bank_income_notification_state"
    key = "crypto_transfer_id" if crypto else "bank_transaction_id"
    eligible = CRYPTO_ELIGIBLE if crypto else ELIGIBLE
    columns = ("b.from_address, b.wallet_address, b.transaction_id" if crypto
               else "b.bank, b.payer_name, b.payer_inn, b.currency, b.purpose, b.raw")
    formatter = format_crypto_income if crypto else format_income
    # With the exclusive session lock no other dispatcher can own sending.
    stale = await conn.fetch(
            f"""UPDATE {journal} SET status='unknown', updated_at=now(),
                 error='Процесс прервался во время отправки; проверьте ветку перед повтором'
               WHERE status='sending' RETURNING {key} AS source_id"""
        )
    issues.extend(f"{kind}:{row['source_id']}" for row in stale)
    await conn.execute(
            f"""INSERT INTO {journal} ({key}, chat_id, thread_id)
                SELECT b.id, $1, $2 FROM {source} b
                CROSS JOIN {state} s
                WHERE b.id > s.baseline_id AND {eligible}
                  AND b.occurred_at >= date_trunc('day', s.started_at AT TIME ZONE 'Europe/Moscow')
                                         AT TIME ZONE 'Europe/Moscow'
                ON CONFLICT ({key}) DO NOTHING""", config.chat_id, config.thread_id,
        )
    # A correction to classification before sending cancels the alert.
    await conn.execute(
            f"""UPDATE {journal} n SET status='skipped', updated_at=now()
                FROM {source} b WHERE b.id=n.{key}
                AND n.status='pending' AND ({eligible}) IS NOT TRUE"""
        )
    rows = await conn.fetch(
            f"""SELECT n.{key} AS source_id
               FROM {journal} n JOIN {source} b ON b.id=n.{key}
               WHERE n.status='pending' AND n.next_attempt_at <= now()
                 AND n.chat_id=$1 AND n.thread_id=$2
               ORDER BY n.created_at, n.{key} LIMIT 20""", config.chat_id, config.thread_id,
        )
    deadline = monotonic() + 30
    for row in rows:
        if monotonic() >= deadline:
            break
        tx_id = row["source_id"]
        claimed = await conn.fetchrow(
            f"""UPDATE {journal} n SET status='sending', attempts=attempts+1,
                 updated_at=now() FROM {source} b
               WHERE n.{key}=$1 AND n.status='pending'
                 AND b.id=n.{key} AND {eligible}
               RETURNING n.attempts, n.created_at, {columns}, b.amount, b.occurred_at""", tx_id,
        )
        if claimed is None:
            continue
        text = formatter(dict(claimed))
        status, message_id, delay = await _deliver(client, config, text)
        if status == "pending" and claimed["attempts"] >= 10:
            status = "failed"
        await conn.execute(
            f"""UPDATE {journal} SET status=$2, message_id=$3, updated_at=now(),
                 sent_at=CASE WHEN $2='sent' THEN now() ELSE NULL END,
                 next_attempt_at=now()+make_interval(secs => $4::int),
                 error=CASE WHEN $2='unknown' THEN 'Доставка не подтверждена; проверьте ветку'
                            WHEN $2='failed' THEN 'Telegram отклонил отправку или исчерпан лимит повторов'
                            WHEN $2='pending' THEN 'Отправка отложена, ожидается повтор' ELSE NULL END
               WHERE {key}=$1""", tx_id, status, message_id, delay,
        )
        if status in ("unknown", "failed"):
            issues.append(f"{kind}:{tx_id}")
        # A limit or bad destination affects the next message as well.
        if status != "sent":
            return False
    return True

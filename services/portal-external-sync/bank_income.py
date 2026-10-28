"""New bank / USDT / manually entered receipts → PolzaSiteFeedbackBot, without replaying history.

Only sendMessage/getMe: the bot's webhook belongs to the existing lead service.
Telegram has no idempotency key. Ambiguous sends are quarantined for manual
review instead of replayed after a timeout or process restart.
"""
from __future__ import annotations

import asyncio
import html
import json
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from time import monotonic
from typing import Callable

import asyncpg
import httpx

from alerts import send_worker_alert
from sources.crypto_usdt import USDT_TRC20_CONTRACT

MSK = timezone(timedelta(hours=3))
LOCK_NAMESPACE = 726462
DELIVERY_LOCK = 3
EXPECTED_BOT = "PolzaSiteFeedbackBot"
BOT_VERIFY_ATTEMPTS = 3


class IncomeBotVerificationError(RuntimeError):
    """Only controlled, token-free reasons may be exposed in a worker alert."""


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


def format_manual_income(row: dict) -> str:
    """Доход, внесённый руками в портале («+ Доход» в «Расходы и доходы»).

    Решение владельца (26.10.2026): такой доход — та же оплата, и в ветку он
    идёт тем же «Поступила оплата». Пометка «внесено вручную» и автор нужны,
    чтобы продажи не искали этот платёж в выписке банка.
    """
    amount = f"{Decimal(str(row['amount'])):,.2f}".replace(",", " ").replace(".", ",")
    currency = "₽" if row["currency"] == "RUB" else _clip(row["currency"], 12)
    entered = row["created_at"].astimezone(MSK).strftime("%d.%m.%Y %H:%M МСК")
    author = _clip(row.get("author_name") or row.get("author_email"), 120) or "неизвестно"
    lines = [
        "💰 <b>Поступила оплата</b> (внесено вручную)", "",
        f"<b>Плательщик:</b> {_clip(row.get('payer'), 240) or 'не указан'}",
        f"<b>Сумма:</b> {amount} {currency}",
        f"<b>Откуда:</b> {_clip(row.get('channel'), 60) or 'не указано'}",
        f"<b>Дата платежа:</b> {row['occurred_on'].strftime('%d.%m.%Y')}",
        f"<b>Внёс:</b> {author}, {entered}",
        f"<b>За что:</b> {_clip(row.get('comment'), 1200) or 'не указано'}",
    ]
    if row.get("project_name"):
        lines.append(f"<b>Проект:</b> {_clip(row['project_name'], 240)}")
    if row.get("amo_deal_id"):
        deal = _clip(row.get("deal_name"), 240)
        lines.append(f"<b>Сделка AMO:</b> {deal + ' · ' if deal else ''}№ {row['amo_deal_id']}")
    return "\n".join(lines)


async def _verify_income_bot(config: IncomeConfig) -> None:
    # getMe is read-only: even a read timeout is safe to retry. Never apply
    # these retries to sendMessage, which may already have delivered a payment.
    async with httpx.AsyncClient(timeout=15) as client:
        for attempt in range(1, BOT_VERIFY_ATTEMPTS + 1):
            try:
                response = await client.get(f"https://api.telegram.org/bot{config.token}/getMe")
                status = response.status_code
                if 400 <= status < 500:
                    # Bad credentials/permissions need attention, not retries.
                    # A 429 also must not be retried ahead of Telegram's limit.
                    raise IncomeBotVerificationError(f"Проверка бота оплат отклонена Telegram (HTTP {status})")
                if status == 200:
                    data = response.json()
                    result = data.get("result") if isinstance(data, dict) else None
                    username = result.get("username") if isinstance(result, dict) else None
                    if isinstance(data, dict) and data.get("ok") is True and isinstance(username, str) and username:
                        if username.lower() != EXPECTED_BOT.lower():
                            raise IncomeBotVerificationError("Токен уведомлений оплат принадлежит другому боту")
                        return
                    reason = "некорректный ответ Telegram"
                else:
                    reason = f"Telegram HTTP {status}"
            except (httpx.HTTPError, ValueError) as error:
                # Exception messages/URLs and Telegram response bodies can
                # contain the bot token. Only the error class is safe to log.
                reason = type(error).__name__
            if attempt == BOT_VERIFY_ATTEMPTS:
                raise IncomeBotVerificationError(
                    f"Проверка бота оплат не прошла после {attempt} попыток ({reason})"
                ) from None
            print(f"[bank-income] bot verification retry {attempt}/{BOT_VERIFY_ATTEMPTS} ({reason})", flush=True)
            await asyncio.sleep(attempt)


async def prepare_income(conn: asyncpg.Connection, config: IncomeConfig) -> None:
    # Verify the exact named bot before baselining or transmitting financial data.
    await _verify_income_bot(config)
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
# Ручной доход всегда выручка (решение владельца), фильтровать нечего.
MANUAL_ELIGIBLE = "b.amount > 0"

# Synced sources: rows past the baseline, dated from the day alerts were enabled.
_SINCE_BASELINE = """b.id > s.baseline_id
    AND b.occurred_at >= date_trunc('day', s.started_at AT TIME ZONE 'Europe/Moscow')
                         AT TIME ZONE 'Europe/Moscow'"""


@dataclass(frozen=True)
class _Queue:
    """SQL identifiers of one journal. They come exclusively from QUEUES below."""
    journal: str
    key: str
    source: str
    state: str
    eligible: str
    # Which source rows are new enough to announce (aliases: b — source, s — state).
    fresh: str
    columns: str
    # Extra joins for the message text only (alias b — source).
    joins: str
    formatter: Callable[[dict], str]


QUEUES: dict[str, _Queue] = {
    "bank": _Queue(
        "bank_income_notifications", "bank_transaction_id", "bank_transactions",
        "bank_income_notification_state", ELIGIBLE, _SINCE_BASELINE,
        "b.bank, b.payer_name, b.payer_inn, b.currency, b.purpose, b.raw, b.amount, b.occurred_at",
        "", format_income,
    ),
    "crypto": _Queue(
        "crypto_income_notifications", "crypto_transfer_id", "crypto_income_transfers",
        "crypto_income_notification_state", CRYPTO_ELIGIBLE, _SINCE_BASELINE,
        "b.from_address, b.wallet_address, b.transaction_id, b.amount, b.occurred_at",
        "", format_crypto_income,
    ),
    # Ручной доход появился 26.10.2026, истории у него нет: baseline не нужен,
    # достаточно не слать записи, внесённые до включения уведомлений. Дата
    # платежа не важна — задним числом внесённая оплата тоже новость для продаж.
    "manual": _Queue(
        "manual_income_notifications", "manual_income_id", "manual_incomes",
        "bank_income_notification_state", MANUAL_ELIGIBLE, "b.created_at >= s.started_at",
        """b.payer, b.channel, b.comment, b.currency, b.amount, b.occurred_on, b.amo_deal_id,
           au.full_name AS author_name, au.email AS author_email,
           pj.name AS project_name, al.name AS deal_name""",
        """LEFT JOIN profiles au ON au.id = b.created_by
           LEFT JOIN projects pj ON pj.id = b.project_id
           LEFT JOIN amo_leads al ON al.amo_id = b.amo_deal_id""",
        format_manual_income,
    ),
}


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
            for kind in QUEUES:
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
    # SQL identifiers come exclusively from the fixed internal QUEUES definitions.
    queue = QUEUES[kind]
    journal, source, state, key = queue.journal, queue.source, queue.state, queue.key
    eligible, columns, formatter = queue.eligible, queue.columns, queue.formatter
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
                WHERE {queue.fresh} AND {eligible}
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
                 updated_at=now() FROM {source} b {queue.joins}
               WHERE n.{key}=$1 AND n.status='pending'
                 AND b.id=n.{key} AND {eligible}
               RETURNING n.attempts, n.created_at, {columns}""", tx_id,
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

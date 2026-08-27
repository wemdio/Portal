"""Точка Банк → bank_transactions.

Тянет приход и расход: Credit → выручка (с классификатором), Debit → расход.
Классифицирует «выручка / не выручка» через _bank_common. UPSERT по
(bank='tochka', transaction_id).

Flow API (Open Banking): GET /balances → список accountId → POST /statements
→ получить statementId → poll GET /accounts/{acc}/statements/{sid} до
status='Ready' → взять Transaction[].

Валюта берётся из Amount.currency (с запасным RUB, если поле не пришло) —
не хардкодится, чтобы платёж не в рублях не лёг в базу рублёвым по ошибке.
Полнота выгрузки периода сверяется по остаткам (startDateBalance /
endDateBalance — см. reconcile_period_totals), пагинации в ответе нет.
Встреченные значения Transaction.status копятся за весь прогон и печатаются
в сводке run() — набор возможных значений заранее не известен, поведение
по status пока не меняем.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import ssl
import traceback
from datetime import date
from functools import lru_cache
from pathlib import Path
from urllib.parse import quote

import asyncpg
import certifi
import httpx

from .base import SyncSource
from ._bank_common import classify_revenue, coerce_amount, parse_date, to_row

JWT = os.environ.get("TOCHKA_JWT", "").strip()
API_BASE = "https://enter.tochka.com/uapi/open-banking/v1.0"

# ─── Доверие к УЦ Минцифры ───────────────────────────────────────────────────
#
# 24.08.2026 Точка переехала на национальный УЦ. Его корня нет в наборе certifi,
# которым httpx пользуется по умолчанию, и с 25.08 синк падал на рукопожатии:
# «self-signed certificate in certificate chain». Речь не о самоподписанном
# сертификате банка — просто корню цепочки никто не выдавал доверия.
#
# Корень подключаем ТОЧЕЧНО, только к этому клиенту, а не ко всему контейнеру.
# Доверенный корень — это разрешение принимать любой сертификат, им подписанный,
# для любого адреса; у синка есть и другие источники, и расширять их доверие
# ради банка незачем. Остальные модули продолжают ходить на обычном certifi.
#
# Стандартные корни при этом остаются: цепочка Точки сегодня целиком российская,
# но если банк вернётся на международный УЦ, соединение не должно сломаться
# второй раз по обратной причине.
_ROOT_CA = Path(__file__).resolve().parent.parent / "certs" / "russian_trusted_root_ca.pem"

# Отпечаток сверен с двумя независимыми источниками: официальной раздачей
# Госуслуг (gu-st.ru) и сертификатом, который сервер Точки предъявляет в
# рукопожатии. Держим его в коде, чтобы подменённый файл уронил тесты, а не
# тихо доехал до прода и не начал молча заверять чужие сертификаты.
_ROOT_CA_SHA256 = "d26d2d0231b7c39f92cc738512ba54103519e4405d68b5bd703e9788ca8ecf31"


def _der_from_pem(pem_text: str) -> bytes:
    """Тело сертификата без заголовков — из него и считается отпечаток."""
    import base64

    body = "".join(
        line.strip()
        for line in pem_text.splitlines()
        if line.strip() and not line.startswith("-----")
    )
    return base64.b64decode(body)


def root_ca_fingerprint() -> str:
    """SHA-256 лежащего в репозитории корня, в нижнем регистре без разделителей."""
    return hashlib.sha256(_der_from_pem(_ROOT_CA.read_text())).hexdigest()


@lru_cache(maxsize=1)
def tochka_ssl_context() -> ssl.SSLContext:
    """
    Проверка сертификата остаётся включённой — меняется только набор корней.

    Соблазн «поправить» это одной строкой `verify=False` здесь особенно велик,
    и именно здесь он особенно дорог: отключённая проверка на банковском API
    означает, что подменить ответ Точки сможет кто угодно на пути. Поэтому
    корень добавляется, а не проверка убирается.

    Файла нет или он подменён — падаем сразу и внятно. Молча вернуть контекст
    без нужного корня значило бы получить тот же неразборчивый SSL-отказ, из-за
    которого выписки не грузились четверо суток.
    """
    if not _ROOT_CA.exists():
        raise RuntimeError(
            f"Нет корневого сертификата УЦ Минцифры: {_ROOT_CA}. "
            "Без него Точка не отвечает — файл должен приехать в образ вместе с кодом."
        )
    actual = root_ca_fingerprint()
    if actual != _ROOT_CA_SHA256:
        raise RuntimeError(
            "Корневой сертификат УЦ Минцифры не совпал с ожидаемым отпечатком: "
            f"{actual} вместо {_ROOT_CA_SHA256}. Файл подменён или обновлён — "
            "сверьте с официальной раздачей Госуслуг, прежде чем менять отпечаток в коде."
        )

    ctx = ssl.create_default_context(cafile=certifi.where())
    ctx.load_verify_locations(cafile=str(_ROOT_CA))
    return ctx

# Backfill: 2023 → сегодня. Точка требует запросить период через POST /statements,
# а потом запросить готовность отдельно; поэтому дробим по годам, иначе полишит
# один statement на несколько минут.
PERIODS = [
    ("2023-01-01", "2023-12-31"),
    ("2024-01-01", "2024-12-31"),
    ("2025-01-01", "2025-12-31"),
    ("2026-01-01", date.today().isoformat()),
]

POLL_ATTEMPTS = 30
POLL_INTERVAL_SEC = 1.5


def _parse_amount(t: dict) -> float | None:
    """Amount.amount → float через общий coerce_amount (см. _bank_common)."""
    return coerce_amount((t.get("Amount") or {}).get("amount"))


def _parse_amount_nat(t: dict) -> float | None:
    """Amount.amountNat → float, тем же путём, что и amount.

    Используется только сверкой остатков (reconcile_period_totals ниже),
    не мапится в bank_transactions: amount там обязан остаться в валюте
    операции, витрина сама конвертирует его по курсу ЦБ."""
    return coerce_amount((t.get("Amount") or {}).get("amountNat"))


def _parse_currency(t: dict) -> str:
    """Amount.currency → верхний регистр, RUB — запасное значение.

    Счёт сегодня рублёвый, поэтому раньше валюта была захардкожена
    константой. Если хоть один платёж придёт не в рублях, он молча ляжет
    рублёвым и завысит рублёвый итог: витрина расходов конвертирует по
    курсу только то, что явно помечено не рублями.
    """
    currency = (t.get("Amount") or {}).get("currency")
    return str(currency).upper() if currency else "RUB"


def _extract_balance(value: object) -> float | None:
    """startDateBalance/endDateBalance → float.

    Банк может прислать остаток и голым числом, и вложенным объектом вида
    Amount ({"amount": ...}) — живого примера структуры на момент написания
    не было, только имена ключей, поэтому оба варианта обрабатываются
    одинаково устойчиво.
    """
    if isinstance(value, dict):
        value = value.get("amount")
    return coerce_amount(value)


def reconcile_period_totals(
    rows: list[dict], statement: dict, tolerance: float = 0.01
) -> list[str]:
    """Сверяет изменение остатка по выписке периода с суммой замапленных
    операций того же периода: endDateBalance - startDateBalance обязано
    равняться сумме приходов минус сумма расходов.

    Пагинации в ответе Точки нет — это единственная доступная проверка
    полноты выгрузки (тот же приём, что reconcile_period_totals у Т-Банка,
    см. sources/bank_tbank.py, только там сверяют с income/outcome, а не с
    остатками). Если сумма замапленных операций не сходится с изменением
    остатка, часть операций до базы не доехала (сетевой сбой периода, битая
    дата/сумма и т.п.).

    rows — словари после map_transaction (до to_row), т.е. уже без
    отфильтрованных/пропущенных операций. statement — сырой объект
    Statement за период (содержит startDateBalance/endDateBalance).

    Сравнение — с допуском tolerance (по умолчанию копейка), не точное
    равенство float. Если полей с остатками в ответе нет — сверка по этому
    периоду молча пропускается, отсутствие полей не ошибка.

    Остатки startDateBalance/endDateBalance — в рублях, а Amount.amount
    операции — в валюте самой операции (см. _parse_currency), не обязательно
    в рублях. Сравнивать их напрямую при валютной операции нельзя — суммы в
    разных шкалах. Amount.amountNat по названию и по документации Точки —
    рублёвый эквивалент суммы, поэтому в сверке используется он, если поле
    пришло (r["amount_nat"] в замапленной строке), и только иначе — amount.
    На живых данных это предположение пока не проверено: все встреченные
    операции рублёвые, и в них amount == amountNat, так что от подмены
    ничего не меняется. Если предположение неверно (например, amountNat
    вдруг не рублёвый эквивалент, а что-то другое), рублёвая сумма разойдётся
    с остатком банка, и предупреждение о расхождении ниже как раз это
    вскроет — молчаливо ошибочным это предположение остаться не может.
    """
    warnings: list[str] = []

    start_balance = _extract_balance(statement.get("startDateBalance"))
    end_balance = _extract_balance(statement.get("endDateBalance"))
    if start_balance is None or end_balance is None:
        return warnings

    def _rub_amount(r: dict) -> float:
        amount_nat = r.get("amount_nat")
        return amount_nat if amount_nat is not None else r["amount"]

    mapped_credit = sum(_rub_amount(r) for r in rows if r["direction"] == "credit")
    mapped_debit = sum(_rub_amount(r) for r in rows if r["direction"] == "debit")
    bank_delta = end_balance - start_balance
    mapped_delta = mapped_credit - mapped_debit
    diff = bank_delta - mapped_delta
    if abs(diff) > tolerance:
        warnings.append(
            f"balance mismatch: start={start_balance} end={end_balance} "
            f"bank_delta={bank_delta} mapped_delta={mapped_delta} diff={diff:+.2f}"
        )
    return warnings


def map_transaction(
    t: dict,
    acc: str,
    skip_counts: dict[str, int] | None = None,
    status_counts: dict[str, int] | None = None,
) -> dict | None:
    """Операция Точки → словарь полей bank_transactions. None — пропустить.

    Возвращаемый словарь несёт один ключ сверх колонок bank_transactions —
    amount_nat (Amount.amountNat, см. _parse_amount_nat). Он существует
    только для reconcile_period_totals и в to_row/BANK_COLUMNS не попадает,
    то есть в саму таблицу не пишется.

    Классификатор «выручка / не выручка» осмыслен только для прихода: у
    расхода нет плательщика-клиента, и прогонять по нему classify_revenue
    значит записывать в exclude_reason случайный мусор.

    Непригодная запись (не разобралась дата или сумма) пропускается с
    предупреждением в лог, а не роняет вызывающий батч: перед бэкфиллом за
    2023 год одна битая строка не должна уносить с собой год операций счёта.
    skip_counts, если передан, копит причины пропуска для сводки по прогону.

    status_counts, если передан, копит встреченные значения Transaction.status
    за весь прогон (для итоговой сводки в run()) — мы не знаем полный набор
    возможных значений заранее, поэтому просто считаем как есть, ничего не
    отбрасывая и не фильтруя по нему. Считается для каждой операции, даже
    той, что дальше будет пропущена по другой причине (неизвестный
    индикатор, битая дата/сумма) — цель здесь увидеть весь спектр значений,
    а не только те, что дошли до записи в базу.
    """
    if status_counts is not None:
        status = t.get("status")
        key = str(status) if status is not None else "<missing>"
        status_counts[key] = status_counts.get(key, 0) + 1

    indicator = t.get("creditDebitIndicator")
    if indicator not in ("Credit", "Debit"):
        return None
    is_credit = indicator == "Credit"

    doc = t.get("documentNumber")
    tx_id = t.get("transactionId") or f"{acc}|{doc}"

    occurred_at = parse_date(t.get("documentProcessDate", ""))
    if occurred_at is None:
        print(
            f"[bank_tochka] skip transactionId={tx_id!r}: не разобралась дата "
            f"documentProcessDate={t.get('documentProcessDate')!r}",
            flush=True,
        )
        if skip_counts is not None:
            skip_counts["bad_date"] = skip_counts.get("bad_date", 0) + 1
        return None

    amount = _parse_amount(t)
    if amount is None:
        print(
            f"[bank_tochka] skip transactionId={tx_id!r}: не разобралась сумма "
            f"Amount={t.get('Amount')!r}",
            flush=True,
        )
        if skip_counts is not None:
            skip_counts["bad_amount"] = skip_counts.get("bad_amount", 0) + 1
        return None

    debtor = t.get("DebtorParty") or {}
    creditor = t.get("CreditorParty") or {}
    purpose = t.get("description", "") or ""

    payer = (debtor.get("name") or "") if is_credit else ""
    payer_inn = (debtor.get("inn") or "") if is_credit else ""
    payee = "" if is_credit else (creditor.get("name") or "")
    payee_inn = "" if is_credit else (creditor.get("inn") or "")

    exclude_reason = classify_revenue(payer, payer_inn, purpose) if is_credit else ""
    is_revenue = (not exclude_reason) if is_credit else None

    return {
        "bank": "tochka",
        "account_id": acc,
        "transaction_id": str(tx_id),
        "document_number": str(doc) if doc is not None else None,
        "occurred_at": occurred_at,
        "amount": amount,
        "amount_nat": _parse_amount_nat(t),
        "currency": _parse_currency(t),
        "direction": "credit" if is_credit else "debit",
        "payer_name": payer or None,
        "payer_inn": payer_inn or None,
        "payee_name": payee or None,
        "payee_inn": payee_inn or None,
        "purpose": purpose or None,
        "is_revenue": is_revenue,
        "exclude_reason": exclude_reason or None,
        "raw": json.dumps(t, ensure_ascii=False),
    }


class BankTochkaSync(SyncSource):
    name = "bank_tochka"

    async def run(self, conn: asyncpg.Connection) -> int:
        if not JWT:
            raise NotImplementedError("TOCHKA_JWT не задан")

        headers = {"Authorization": f"Bearer {JWT}", "Content-Type": "application/json"}
        total = 0
        skip_counts: dict[str, int] = {}
        status_counts: dict[str, int] = {}

        async with httpx.AsyncClient(
            timeout=90, headers=headers, verify=tochka_ssl_context()
        ) as client:
            bal = await client.get(f"{API_BASE}/balances")
            bal.raise_for_status()
            accounts = sorted({
                b["accountId"] for b in bal.json().get("Data", {}).get("Balance", [])
            })

            for acc in accounts:
                for st, en in PERIODS:
                    # Изоляция периода: сбой одного счёта/периода (сеть, битые
                    # данные, ошибка upsert) не должен обрывать остальные —
                    # источник обязан дойти до конца и залить то, что удалось.
                    try:
                        rows = await self._fetch_period(
                            client, acc, st, en, skip_counts, status_counts
                        )
                        if rows:
                            await self._upsert(conn, rows)
                            total += len(rows)
                    except Exception as e:
                        print(
                            f"[bank_tochka] period FAIL acc={acc} {st}..{en}: {e}\n{traceback.format_exc()}",
                            flush=True,
                        )

        if skip_counts:
            total_skipped = sum(skip_counts.values())
            breakdown = ", ".join(
                f"{reason}={n}" for reason, n in sorted(skip_counts.items())
            )
            print(
                f"[bank_tochka] skipped {total_skipped} record(s): {breakdown}",
                flush=True,
            )

        if status_counts:
            # Набор возможных значений Transaction.status заранее не известен —
            # просто печатаем встреченное с количествами, ничего не отбрасывая.
            # Дальнейшее решение (фильтровать ли какие-то статусы) принимается
            # осознанно на основании этой сводки, а не заранее угадывается.
            breakdown = ", ".join(
                f"{status}={n}" for status, n in sorted(status_counts.items())
            )
            print(f"[bank_tochka] statuses seen: {breakdown}", flush=True)

        return total

    async def _fetch_period(
        self,
        client: httpx.AsyncClient,
        acc: str,
        st: str,
        en: str,
        skip_counts: dict[str, int] | None = None,
        status_counts: dict[str, int] | None = None,
    ) -> list[tuple]:
        create = await client.post(
            f"{API_BASE}/statements",
            json={"Data": {"Statement": {"accountId": acc, "startDateTime": st, "endDateTime": en}}},
        )
        if create.status_code >= 400:
            return []
        sid = create.json()["Data"]["Statement"]["statementId"]
        accq = quote(acc, safe="")

        stmt = None
        for _ in range(POLL_ATTEMPTS):
            r = await client.get(f"{API_BASE}/accounts/{accq}/statements/{sid}")
            if r.status_code == 200:
                st_arr = r.json().get("Data", {}).get("Statement") or []
                if st_arr and st_arr[0].get("status") == "Ready":
                    stmt = st_arr[0]
                    break
            await asyncio.sleep(POLL_INTERVAL_SEC)
        if not stmt:
            return []

        mapped_rows: list[dict] = []
        for t in stmt.get("Transaction", []) or []:
            mapped = map_transaction(t, acc, skip_counts, status_counts)
            if mapped is not None:
                mapped_rows.append(mapped)

        for warning in reconcile_period_totals(mapped_rows, stmt):
            print(f"[bank_tochka] acc={acc} {st}..{en}: {warning}", flush=True)

        return [to_row(m) for m in mapped_rows]

    async def _upsert(self, conn: asyncpg.Connection, rows: list[tuple]) -> None:
        await conn.executemany(
            """INSERT INTO bank_transactions (
                 bank, account_id, transaction_id, document_number,
                 occurred_at, amount, currency, direction,
                 payer_name, payer_inn, payee_name, payee_inn,
                 purpose, is_revenue, exclude_reason, raw
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
               ON CONFLICT (bank, transaction_id) DO UPDATE SET
                 direction      = EXCLUDED.direction,
                 payee_name     = EXCLUDED.payee_name,
                 payee_inn      = EXCLUDED.payee_inn,
                 is_revenue     = EXCLUDED.is_revenue,
                 exclude_reason = EXCLUDED.exclude_reason,
                 raw            = EXCLUDED.raw,
                 synced_at      = now()""",
            rows,
        )

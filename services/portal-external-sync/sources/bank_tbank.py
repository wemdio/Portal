"""Т-Банк → bank_transactions.

Тянет операции по нашему счёту в обе стороны: recipientAccount == наш счёт →
приход (с классификатором выручки), payerAccount == наш счёт → расход.
Операция, где нашего счёта нет ни с одной стороны, — не наша, пропускается.
Классификатор «выручка / не выручка» — общий с Точкой, из _bank_common.
UPSERT по (bank='tbank', transaction_id).

Счёт по умолчанию — из архива CEO. Можно переопределить через TBANK_ACCOUNT
если у студии добавится второй счёт.
"""
from __future__ import annotations

import json
import os
import traceback
from datetime import date

import asyncpg
import httpx

from .base import SyncSource
from ._bank_common import classify_revenue, coerce_amount, parse_date, to_row

TOKEN = os.environ.get("TBANK_TOKEN", "").strip()
ACCOUNT = os.environ.get("TBANK_ACCOUNT", "40802810600001780269").strip()
API_URL = "https://business.tbank.ru/openapi/api/v1/bank-statement"

PERIODS = [
    ("2023-01-01", "2023-12-31"),
    ("2024-01-01", "2024-12-31"),
    ("2025-01-01", "2025-12-31"),
    ("2026-01-01", date.today().isoformat()),
]


def map_operation(
    o: dict, account: str, skip_counts: dict[str, int] | None = None
) -> dict | None:
    """Операция Т-Банка → словарь полей bank_transactions. None — пропустить.

    У Т-Банка нет поля-индикатора направления, как у Точки: направление
    определяем по тому, какой стороной стоит наш счёт. recipientAccount ==
    наш счёт → приход, payerAccount == наш счёт → расход, ни там ни там —
    операция не наша.

    Классификатор «выручка / не выручка» осмыслен только для прихода: у
    расхода нет плательщика-клиента, и прогонять по нему classify_revenue
    значит записывать в exclude_reason случайный мусор.

    Непригодная запись (не разобралась дата или сумма) пропускается с
    предупреждением в лог, а не роняет вызывающий батч: перед бэкфиллом за
    2023 год одна битая строка не должна уносить с собой весь период.
    skip_counts, если передан, копит причины пропуска для сводки по прогону.

    Чужая операция (наш счёт не с одной из сторон) считается в skip_counts
    под причиной "not_ours" без построчного лога — их много, и без счётчика
    молчаливая опечатка в имени поля API (например, если ответ вдруг придёт
    не с payerAccount, а с другим ключом) выглядела бы как "за период не
    было расходов", а не как поломка маппинга.
    """
    is_credit = o.get("recipientAccount") == account
    is_debit = o.get("payerAccount") == account
    if not is_credit and not is_debit:
        if skip_counts is not None:
            skip_counts["not_ours"] = skip_counts.get("not_ours", 0) + 1
        return None

    tx_id = o.get("operationId") or f"{account}|{o.get('id')}"

    occurred_at = parse_date(o.get("date", ""))
    if occurred_at is None:
        print(
            f"[bank_tbank] skip operationId={tx_id!r}: не разобралась дата "
            f"date={o.get('date')!r}",
            flush=True,
        )
        if skip_counts is not None:
            skip_counts["bad_date"] = skip_counts.get("bad_date", 0) + 1
        return None

    amount = coerce_amount(o.get("amount"))
    if amount is None:
        print(
            f"[bank_tbank] skip operationId={tx_id!r}: не разобралась сумма "
            f"amount={o.get('amount')!r}",
            flush=True,
        )
        if skip_counts is not None:
            skip_counts["bad_amount"] = skip_counts.get("bad_amount", 0) + 1
        return None

    purpose = o.get("paymentPurpose", "") or ""
    payer = (o.get("payerName") or "") if is_credit else ""
    payer_inn = (o.get("payerInn") or "") if is_credit else ""
    payee = "" if is_credit else (o.get("recipient") or "")
    payee_inn = "" if is_credit else (o.get("recipientInn") or "")

    exclude_reason = classify_revenue(payer, payer_inn, purpose) if is_credit else ""
    is_revenue = (not exclude_reason) if is_credit else None

    return {
        "bank": "tbank",
        "account_id": account,
        "transaction_id": str(tx_id),
        "document_number": str(o.get("id")) if o.get("id") is not None else None,
        "occurred_at": occurred_at,
        "amount": amount,
        "currency": "RUB",
        "direction": "credit" if is_credit else "debit",
        "payer_name": payer or None,
        "payer_inn": payer_inn or None,
        "payee_name": payee or None,
        "payee_inn": payee_inn or None,
        "purpose": purpose or None,
        "is_revenue": is_revenue,
        "exclude_reason": exclude_reason or None,
        "raw": json.dumps(o, ensure_ascii=False),
    }


def reconcile_period_totals(
    rows: list[dict], data: dict, tolerance: float = 0.01
) -> list[str]:
    """Сверяет сумму замапленных операций периода с income/outcome, которые
    банк сам посчитал за тот же период в ответе /bank-statement.

    Это единственная доступная проверка полноты выгрузки: у ручки нет ни
    курсора, ни total — раньше расхождение с ожидаемым числом операций можно
    было объяснить только подозрением на пагинацию. Если сумма замапленных
    приходов/расходов не сходится с income/outcome банка, часть операций до
    базы не доехала (сетевой сбой периода, битая дата/сумма и т.п.) — то же
    самое, что раньше пытались ловить пагинацией, только без домыслов о её
    существовании.

    rows — словари после map_operation (до to_row), т.е. уже без
    отфильтрованных/пропущенных операций. data — сырой ответ API за период.

    Сравнение — с допуском tolerance (по умолчанию копейка), не точное
    равенство float. Если банк не прислал income или outcome в ответе,
    сверка по этому полю молча пропускается — отсутствие поля не ошибка.
    """
    warnings: list[str] = []

    income = data.get("income")
    if income is not None:
        mapped_income = sum(r["amount"] for r in rows if r["direction"] == "credit")
        diff = mapped_income - float(income)
        if abs(diff) > tolerance:
            warnings.append(
                f"income mismatch: bank={income} mapped={mapped_income} diff={diff:+.2f}"
            )

    outcome = data.get("outcome")
    if outcome is not None:
        mapped_outcome = sum(r["amount"] for r in rows if r["direction"] == "debit")
        diff = mapped_outcome - float(outcome)
        if abs(diff) > tolerance:
            warnings.append(
                f"outcome mismatch: bank={outcome} mapped={mapped_outcome} diff={diff:+.2f}"
            )

    return warnings


class BankTBankSync(SyncSource):
    name = "bank_tbank"

    async def run(self, conn: asyncpg.Connection) -> int:
        if not TOKEN:
            raise NotImplementedError("TBANK_TOKEN не задан")
        if not ACCOUNT:
            # Пустой ACCOUNT делает is_credit/is_debit истинными для любой
            # операции с пустым recipientAccount/payerAccount — часть
            # внутренних банковских операций помечена именно так.
            raise NotImplementedError("TBANK_ACCOUNT не задан")

        headers = {"Authorization": f"Bearer {TOKEN}"}
        total = 0
        skip_counts: dict[str, int] = {}

        async with httpx.AsyncClient(timeout=120, headers=headers) as client:
            for frm, till in PERIODS:
                # Изоляция периода: сбой одного периода (сеть, битые данные,
                # ошибка upsert) не должен обрывать остальные — источник
                # обязан дойти до конца и залить то, что удалось.
                try:
                    resp = await client.get(
                        API_URL, params={"accountNumber": ACCOUNT, "from": frm, "till": till}
                    )
                    if resp.status_code >= 400:
                        # Пропускаем период с ошибкой — не валим весь синк.
                        continue
                    data = resp.json()

                    mapped_rows: list[dict] = []
                    for o in data.get("operation", []) or []:
                        mapped = map_operation(o, ACCOUNT, skip_counts)
                        if mapped is not None:
                            mapped_rows.append(mapped)
                    if mapped_rows:
                        await self._upsert(conn, [to_row(m) for m in mapped_rows])
                        total += len(mapped_rows)

                    for warning in reconcile_period_totals(mapped_rows, data):
                        print(
                            f"[bank_tbank] {frm}..{till}: {warning}",
                            flush=True,
                        )
                except Exception as e:
                    print(
                        f"[bank_tbank] period FAIL {frm}..{till}: {e}\n{traceback.format_exc()}",
                        flush=True,
                    )

        if skip_counts:
            total_skipped = sum(skip_counts.values())
            breakdown = ", ".join(
                f"{reason}={n}" for reason, n in sorted(skip_counts.items())
            )
            print(
                f"[bank_tbank] skipped {total_skipped} record(s): {breakdown}",
                flush=True,
            )

        return total

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

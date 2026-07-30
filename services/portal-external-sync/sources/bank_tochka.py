"""Точка Банк → bank_transactions.

Тянет приход и расход: Credit → выручка (с классификатором), Debit → расход.
Классифицирует «выручка / не выручка» через _bank_common. UPSERT по
(bank='tochka', transaction_id).

Flow API (Open Banking): GET /balances → список accountId → POST /statements
→ получить statementId → poll GET /accounts/{acc}/statements/{sid} до
status='Ready' → взять Transaction[].
"""
from __future__ import annotations

import asyncio
import json
import os
from datetime import date
from urllib.parse import quote

import asyncpg
import httpx

from .base import SyncSource
from ._bank_common import classify_revenue, coerce_amount, parse_date, to_row

JWT = os.environ.get("TOCHKA_JWT", "").strip()
API_BASE = "https://enter.tochka.com/uapi/open-banking/v1.0"

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


def map_transaction(
    t: dict, acc: str, skip_counts: dict[str, int] | None = None
) -> dict | None:
    """Операция Точки → словарь полей bank_transactions. None — пропустить.

    Классификатор «выручка / не выручка» осмыслен только для прихода: у
    расхода нет плательщика-клиента, и прогонять по нему classify_revenue
    значит записывать в exclude_reason случайный мусор.

    Непригодная запись (не разобралась дата или сумма) пропускается с
    предупреждением в лог, а не роняет вызывающий батч: перед бэкфиллом за
    2023 год одна битая строка не должна уносить с собой год операций счёта.
    skip_counts, если передан, копит причины пропуска для сводки по прогону.
    """
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
        "currency": "RUB",
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

        async with httpx.AsyncClient(timeout=90, headers=headers) as client:
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
                        rows = await self._fetch_period(client, acc, st, en, skip_counts)
                        if rows:
                            await self._upsert(conn, rows)
                            total += len(rows)
                    except Exception as e:
                        print(
                            f"[bank_tochka] period FAIL acc={acc} {st}..{en}: {e}",
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

        return total

    async def _fetch_period(
        self,
        client: httpx.AsyncClient,
        acc: str,
        st: str,
        en: str,
        skip_counts: dict[str, int] | None = None,
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

        rows: list[tuple] = []
        for t in stmt.get("Transaction", []) or []:
            mapped = map_transaction(t, acc, skip_counts)
            if mapped is not None:
                rows.append(to_row(mapped))
        return rows

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

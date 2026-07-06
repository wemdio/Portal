"""Т-Банк → bank_transactions.

Тянет входящие операции (recipientAccount == наш счёт) за все периоды через
GET /openapi/api/v1/bank-statement. Классификатор «выручка / не выручка» —
общий с Точкой, из _bank_common.
UPSERT по (bank='tbank', transaction_id).

Счёт по умолчанию — из архива CEO. Можно переопределить через TBANK_ACCOUNT
если у студии добавится второй счёт.
"""
from __future__ import annotations

import json
import os
from datetime import date

import asyncpg
import httpx

from .base import SyncSource
from ._bank_common import classify_revenue, parse_date

TOKEN = os.environ.get("TBANK_TOKEN", "").strip()
ACCOUNT = os.environ.get("TBANK_ACCOUNT", "40802810600001780269").strip()
API_URL = "https://business.tbank.ru/openapi/api/v1/bank-statement"

PERIODS = [
    ("2023-01-01", "2023-12-31"),
    ("2024-01-01", "2024-12-31"),
    ("2025-01-01", "2025-12-31"),
    ("2026-01-01", date.today().isoformat()),
]


class BankTBankSync(SyncSource):
    name = "bank_tbank"

    async def run(self, conn: asyncpg.Connection) -> int:
        if not TOKEN:
            raise NotImplementedError("TBANK_TOKEN не задан")

        headers = {"Authorization": f"Bearer {TOKEN}"}
        total = 0

        async with httpx.AsyncClient(timeout=120, headers=headers) as client:
            for frm, till in PERIODS:
                resp = await client.get(
                    API_URL, params={"accountNumber": ACCOUNT, "from": frm, "till": till}
                )
                if resp.status_code >= 400:
                    # Пропускаем период с ошибкой — не валим весь синк.
                    continue
                data = resp.json()

                rows: list[tuple] = []
                for o in data.get("operation", []) or []:
                    if o.get("recipientAccount") != ACCOUNT:
                        continue  # только входящие на наш счёт
                    payer = o.get("payerName", "") or ""
                    payer_inn = o.get("payerInn", "") or ""
                    purpose = o.get("paymentPurpose", "") or ""
                    exclude_reason = classify_revenue(payer, payer_inn, purpose)
                    tx_id = o.get("operationId") or f"{ACCOUNT}|{o.get('id')}"
                    rows.append((
                        "tbank",
                        ACCOUNT,
                        str(tx_id),
                        str(o.get("id")) if o.get("id") is not None else None,
                        parse_date(o.get("date", "")),
                        float(o.get("amount", 0)),
                        "RUB",
                        "credit",
                        payer or None,
                        payer_inn or None,
                        None, None,
                        purpose or None,
                        (not exclude_reason),
                        exclude_reason or None,
                        json.dumps(o, ensure_ascii=False),
                    ))
                if rows:
                    await self._upsert(conn, rows)
                    total += len(rows)

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
                 is_revenue     = EXCLUDED.is_revenue,
                 exclude_reason = EXCLUDED.exclude_reason,
                 raw            = EXCLUDED.raw,
                 synced_at      = now()""",
            rows,
        )

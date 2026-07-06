"""Точка Банк → bank_transactions.

Тянет входящие транзакции (только creditDebitIndicator='Credit') за все
периоды. Классифицирует «выручка / не выручка» через _bank_common.
UPSERT по (bank='tochka', transaction_id).

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
from ._bank_common import classify_revenue, parse_date

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


class BankTochkaSync(SyncSource):
    name = "bank_tochka"

    async def run(self, conn: asyncpg.Connection) -> int:
        if not JWT:
            raise NotImplementedError("TOCHKA_JWT не задан")

        headers = {"Authorization": f"Bearer {JWT}", "Content-Type": "application/json"}
        total = 0

        async with httpx.AsyncClient(timeout=90, headers=headers) as client:
            bal = await client.get(f"{API_BASE}/balances")
            bal.raise_for_status()
            accounts = sorted({
                b["accountId"] for b in bal.json().get("Data", {}).get("Balance", [])
            })

            for acc in accounts:
                for st, en in PERIODS:
                    rows = await self._fetch_period(client, acc, st, en)
                    if rows:
                        await self._upsert(conn, rows)
                        total += len(rows)

        return total

    async def _fetch_period(
        self, client: httpx.AsyncClient, acc: str, st: str, en: str
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
            if t.get("creditDebitIndicator") != "Credit":
                continue
            dp = t.get("DebtorParty") or {}
            payer = dp.get("name", "") or ""
            payer_inn = dp.get("inn", "") or ""
            purpose = t.get("description", "") or ""
            exclude_reason = classify_revenue(payer, payer_inn, purpose)
            tx_id = t.get("transactionId") or f"{acc}|{t.get('documentNumber')}"
            occurred = parse_date(t.get("documentProcessDate", ""))
            amount = float((t.get("Amount") or {}).get("amount", 0))
            rows.append((
                "tochka",
                acc,
                str(tx_id),
                str(t.get("documentNumber")) if t.get("documentNumber") is not None else None,
                occurred,
                amount,
                "RUB",
                "credit",
                payer or None,
                payer_inn or None,
                None,  # payee_name — мы (не пишем)
                None,  # payee_inn
                purpose or None,
                (not exclude_reason),
                exclude_reason or None,
                json.dumps(t, ensure_ascii=False),
            ))
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
                 is_revenue     = EXCLUDED.is_revenue,
                 exclude_reason = EXCLUDED.exclude_reason,
                 raw            = EXCLUDED.raw,
                 synced_at      = now()""",
            rows,
        )

"""Точка Банк → bank_transactions (bank='tochka').

TODO: адаптировать из
  contour_code_archive_2026_06_26/microservices_scripts/polza_analytics/extract_banks.py
  (функция tochka_events)

Логика (готова в архиве):
  - https://enter.tochka.com/uapi/open-banking/v1.0
  - Bearer TOCHKA_JWT
  - /balances → список accountId
  - POST /statements → statementId, poll до status='Ready'
  - Транзакции с creditDebitIndicator + классификатор non_revenue()
  - UPSERT по (bank='tochka', transaction_id)
"""
from __future__ import annotations

import os

import asyncpg

from .base import SyncSource

JWT = os.environ.get("TOCHKA_JWT", "").strip()


class BankTochkaSync(SyncSource):
    name = "bank_tochka"

    async def run(self, conn: asyncpg.Connection) -> int:
        if not JWT:
            raise NotImplementedError("TOCHKA_JWT не задан")
        raise NotImplementedError("Точка sync stub — реализовать из extract_banks.py tochka_events")

"""Т-Банк → bank_transactions (bank='tbank').

TODO: адаптировать из
  contour_code_archive_2026_06_26/microservices_scripts/polza_analytics/extract_banks.py
  (соседняя функция tbank_events; в архиве она была ниже tochka_events)

UPSERT по (bank='tbank', transaction_id).
"""
from __future__ import annotations

import os

import asyncpg

from .base import SyncSource

TOKEN = os.environ.get("TBANK_TOKEN", "").strip()


class BankTBankSync(SyncSource):
    name = "bank_tbank"

    async def run(self, conn: asyncpg.Connection) -> int:
        if not TOKEN:
            raise NotImplementedError("TBANK_TOKEN не задан")
        raise NotImplementedError("Т-Банк sync stub — реализовать из extract_banks.py tbank_events")

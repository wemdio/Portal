"""AMO CRM → amo_leads (+ amo_events).

TODO: адаптировать из
  contour_code_archive_2026_06_26/microservices_scripts/polza_analytics/extract_amocrm.py

Логика (готова в архиве CEO):
  - AMO_BASE_URL/api/v4/leads?with=contacts&limit=250, page=...
  - Bearer AMO_ACCESS_TOKEN
  - Кастомное поле ym_client_id (id из AMO_FIELD_YM_CLIENT_ID)
  - Пейджинг по _links.next
  - UPSERT по amo_id
"""
from __future__ import annotations

import os

import asyncpg

from .base import SyncSource

TOKEN = (os.environ.get("AMO_ACCESS_TOKEN") or os.environ.get("AMOCRM_TOKEN") or "").strip()
BASE_URL = os.environ.get("AMO_BASE_URL", "").strip()
YM_FIELD_ID = os.environ.get("AMO_FIELD_YM_CLIENT_ID", "").strip()


class AmoSync(SyncSource):
    name = "amo_leads"

    async def run(self, conn: asyncpg.Connection) -> int:
        if not TOKEN or not BASE_URL:
            raise NotImplementedError("AMO_ACCESS_TOKEN / AMO_BASE_URL не заданы")
        # См. TODO в docstring — забирать из архива CEO.
        raise NotImplementedError("AMO sync stub — реализовать из extract_amocrm.py")

"""Brocard (виртуальные карты) → brocard_transactions.

Доступы на момент написания не выданы. Пока нет BROCARD_API_KEY, источник
поднимает NotImplementedError — main.py залогирует прогон как 'partial' и
продолжит остальные источники.

Когда ключи появятся: заполнить API_BASE и _fetch(), маппинг класть в те же
колонки brocard_transactions (см. миграцию 20260730_0001).
"""
from __future__ import annotations

import os

import asyncpg

from .base import SyncSource

API_KEY = os.environ.get("BROCARD_API_KEY", "").strip()


class BrocardSync(SyncSource):
    name = "brocard"

    async def run(self, conn: asyncpg.Connection) -> int:
        if not API_KEY:
            raise NotImplementedError("BROCARD_API_KEY не задан")
        raise NotImplementedError("Brocard: адаптер не реализован — нет доступов к API")

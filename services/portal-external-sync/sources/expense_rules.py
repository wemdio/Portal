"""Применение правил разметки расходов.

Вся логика в SQL-функции apply_expense_rules(): её же зовёт API после ручной
разметки с созданием правила. Держать вторую реализацию на Python значило бы
получить два расходящихся ответа на один вопрос.

Идёт последним в SOURCES: размечать нужно то, что уже приехало этой ночью.
"""
from __future__ import annotations

import asyncpg

from .base import SyncSource


class ExpenseRulesSync(SyncSource):
    name = "expense_rules"

    async def run(self, conn: asyncpg.Connection) -> int:
        return int(await conn.fetchval("SELECT public.apply_expense_rules()"))

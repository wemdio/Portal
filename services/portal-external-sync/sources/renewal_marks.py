"""Автоподтверждение продлений по тексту задачи AMO и по project_type.

Целиком в SQL-функции apply_renewal_marks() (см.
supabase/migrations/20260803_0002_renewal_marks.sql) — тот же принцип, что у
apply_meeting_deal_links()/apply_expense_rules(): подбор кандидатов и
автоматчинг живут в одном месте (в базе), а не дублируются на Python, иначе
экран разбора (кнопка «Пересчитать») и ночной синк дали бы два расходящихся
ответа на один вопрос.

Место в SOURCES (main.py) — СТРОГО после AmoTasksSync() и после банковских
источников (BankTochkaSync/BankTBankSync): функция ищет задачи со словом
«продл»/«пролонг» в свежих amo_tasks и сверяет их с только что приехавшими
платежами bank_transactions — обоим нужны данные ЭТОЙ же ночи, иначе
подтверждение отстаёт на сутки от того, что могло бы подтвердиться сразу.
"""
from __future__ import annotations

import os

import asyncpg

from .base import SyncSource

#: Потолок времени на один прогон автоматчера.
#:
#: Функция каждую ночь пересматривает ВСЕ приходы с ИНН (кроме первого от
#: каждого ИНН) против всех задач AMO подходящих сделок — не только новые.
#: Сейчас это сотни строк, но объём растёт вместе с банковской историей и
#: количеством задач. Источник стоит в хвосте списка (после банков и
#: amo_tasks) — без потолка залипший матчер молча задержал бы только то, что
#: идёт следом (ExpenseRulesSync), но не должен делать это тихо: с потолком
#: тот же случай падает с внятной ошибкой в external_sync_runs. Падать громко
#: лучше, чем тормозить молча — тот же довод, что в sources/meeting_links.py.
STATEMENT_TIMEOUT = os.environ.get("RENEWAL_MARKS_STATEMENT_TIMEOUT", "120s")


class RenewalMarksSync(SyncSource):
    #: Имя уже разрешено CHECK-констрейнтом external_sync_runs.source
    #: (supabase/migrations/20260803_0002_renewal_marks.sql).
    name = "renewal_marks"

    async def run(self, conn: asyncpg.Connection) -> int:
        # SET LOCAL живёт до конца транзакции и откатывается вместе с ней —
        # поэтому потолок не протечёт на следующие источники, которые делят
        # это же соединение. Обычный SET протёк бы.
        async with conn.transaction():
            await conn.execute(f"SET LOCAL statement_timeout = '{STATEMENT_TIMEOUT}'")
            return int(await conn.fetchval("SELECT public.apply_renewal_marks()"))

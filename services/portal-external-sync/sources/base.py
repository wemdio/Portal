"""Base class for sync sources. Subclasses override .name and .run()."""
from __future__ import annotations

import asyncpg


class SyncSource:
    #: Должно совпадать с CHECK constraint external_sync_runs.source
    #: ('metrika' | 'amo_leads' | 'amo_events' | 'bank_tochka' | 'bank_tbank' |
    #: 'attribution' | 'amo_enrich' | 'leads_report_marketing' |
    #: 'leads_report_outreach' | 'leads_report_summary' | 'brocard' | 'fx_cbr' |
    #: 'expense_rules' | 'meeting_links' | 'crypto_usdt' | 'amo_tasks' |
    #: 'renewal_marks'). См.
    #: supabase/migrations/20260730_0001_expenses_core.sql,
    #: supabase/migrations/20260731_0004_crypto_income.sql,
    #: supabase/migrations/20260731_0003_meeting_links_sync_source.sql,
    #: supabase/migrations/20260803_0001_amo_tasks.sql и
    #: supabase/migrations/20260803_0002_renewal_marks.sql.
    name: str = ""

    async def run(self, conn: asyncpg.Connection) -> int:
        """Sync + upsert. Возвращает число upsert'нутых записей.

        Raise NotImplementedError → main.py залогирует как 'partial' (не ошибка,
        просто источник ещё не готов). Любое другое исключение → 'error'.
        """
        raise NotImplementedError(f"{self.name}: not yet implemented")

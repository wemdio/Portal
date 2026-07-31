"""Тест на источник meeting_links.

Проверяем ровно то, что важно у тонкого source-обёртки над SQL-функцией
(тот же принцип, что и у apply_expense_rules): run() обязан звать именно
apply_meeting_deal_links() — не что-то похожее по имени — и отдать
результат как int, даже если фейковый conn вернул что-то другое (реальный
asyncpg на integer-колонке отдаёт python int, но явный int() в исходнике —
страховка от моков и от смены типа возврата в SQL-функции).
"""
from __future__ import annotations

from sources.meeting_links import MeetingLinksSync


class _FakeConn:
    def __init__(self, value):
        self._value = value
        self.fetchval_calls: list[tuple] = []

    async def fetchval(self, query, *args):
        self.fetchval_calls.append((query, args))
        return self._value


async def test_run_calls_apply_meeting_deal_links_and_returns_int():
    conn = _FakeConn(341)
    result = await MeetingLinksSync().run(conn)

    assert result == 341
    assert isinstance(result, int)
    assert len(conn.fetchval_calls) == 1
    query, args = conn.fetchval_calls[0]
    assert "apply_meeting_deal_links" in query
    assert args == ()


async def test_run_casts_fetchval_result_to_int():
    conn = _FakeConn("7")
    result = await MeetingLinksSync().run(conn)

    assert result == 7
    assert isinstance(result, int)


def test_name_matches_sync_source_registry():
    # Должно совпадать с именем, зарегистрированным в CHECK external_sync_runs.source
    # (supabase/migrations/20260731_0003_meeting_links_sync_source.sql) — иначе
    # log_run_start() в main.py уронит весь ночной цикл, а не один источник.
    assert MeetingLinksSync.name == "meeting_links"

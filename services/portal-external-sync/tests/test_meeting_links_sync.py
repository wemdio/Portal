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


class _FakeTx:
    def __init__(self, conn):
        self._conn = conn

    async def __aenter__(self):
        self._conn.tx_depth += 1
        self._conn.events.append("tx_enter")
        return self

    async def __aexit__(self, *exc):
        self._conn.events.append("tx_exit")
        return False


class _FakeConn:
    def __init__(self, value):
        self._value = value
        self.fetchval_calls: list[tuple] = []
        self.execute_calls: list[str] = []
        self.events: list[str] = []
        self.tx_depth = 0

    def transaction(self):
        return _FakeTx(self)

    async def execute(self, query, *args):
        self.execute_calls.append(query)
        self.events.append("execute")

    async def fetchval(self, query, *args):
        self.fetchval_calls.append((query, args))
        self.events.append("fetchval")
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


async def test_run_bounds_execution_with_local_statement_timeout():
    """Потолок обязан быть SET LOCAL и внутри транзакции.

    Источник стоит выше банков и курсов и делит с ними соединение. Обычный SET
    протёк бы на них: у следующих источников внезапно появился бы чужой лимит.
    А без потолка залипший матчер молча задержал бы весь ночной цикл — при том
    что цикл должен успеть до отчёта продаж в 17:00.
    """
    conn = _FakeConn(1)
    await MeetingLinksSync().run(conn)

    assert len(conn.execute_calls) == 1
    stmt = conn.execute_calls[0].lower()
    assert "set local" in stmt, "обычный SET протечёт на следующие источники"
    assert "statement_timeout" in stmt

    # Порядок важен: потолок выставляется ДО тяжёлого запроса и внутри транзакции.
    assert conn.events == ["tx_enter", "execute", "fetchval", "tx_exit"]


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

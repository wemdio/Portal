"""Тест на источник renewal_marks.

Проверяем ровно то, что важно у тонкого source-обёртки над SQL-функцией
(тот же принцип, что и у test_meeting_links_sync.py): run() обязан звать
именно apply_renewal_marks() — не что-то похожее по имени — и отдать
результат как int, даже если фейковый conn вернул что-то другое; потолок
времени обязан быть SET LOCAL внутри транзакции, а не голый SET (иначе
протечёт на следующие источники, делящие то же соединение).
"""
from __future__ import annotations

from sources.renewal_marks import RenewalMarksSync


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


async def test_run_calls_apply_renewal_marks_and_returns_int():
    conn = _FakeConn(6)
    result = await RenewalMarksSync().run(conn)

    assert result == 6
    assert isinstance(result, int)
    assert len(conn.fetchval_calls) == 1
    query, args = conn.fetchval_calls[0]
    assert "apply_renewal_marks" in query
    assert args == ()


async def test_run_bounds_execution_with_local_statement_timeout():
    """Потолок обязан быть SET LOCAL и внутри транзакции.

    Источник делит соединение со всеми источниками ночного цикла. Обычный SET
    протёк бы на следующие за ним (ExpenseRulesSync) — у него внезапно
    появился бы чужой лимит.
    """
    conn = _FakeConn(1)
    await RenewalMarksSync().run(conn)

    assert len(conn.execute_calls) == 1
    stmt = conn.execute_calls[0].lower()
    assert "set local" in stmt, "обычный SET протечёт на следующие источники"
    assert "statement_timeout" in stmt

    # Порядок важен: потолок выставляется ДО тяжёлого запроса и внутри транзакции.
    assert conn.events == ["tx_enter", "execute", "fetchval", "tx_exit"]


async def test_run_casts_fetchval_result_to_int():
    conn = _FakeConn("14")
    result = await RenewalMarksSync().run(conn)

    assert result == 14
    assert isinstance(result, int)


def test_name_matches_sync_source_registry():
    # Должно совпадать с именем, зарегистрированным в CHECK external_sync_runs.source
    # (supabase/migrations/20260803_0002_renewal_marks.sql) — иначе
    # log_run_start() в main.py уронит весь ночной цикл, а не один источник.
    assert RenewalMarksSync.name == "renewal_marks"

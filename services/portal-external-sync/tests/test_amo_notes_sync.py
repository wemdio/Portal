"""Тесты на watermark и защиту от усечения в AmoNotesSync.run().

Отдельно от test_amo_notes_mapping.py (там — только чистая _to_row). Здесь,
по образцу test_amo_tasks_sync.py / test_amo_events_sync.py, проверяется:
- _watermark читает исключительно amo_notes (по created_at_amo, НЕ
  updated_at_amo — у комментариев нет updated_at), никогда external_sync_runs;
- run() бросает исключение, если упёрся в MAX_PAGES, а не тихо возвращает
  частичный результат;
- run() не бросает исключение на честном завершении (последняя страница
  неполная);
- верхняя граница окна (filter[created_at][to]) одна и та же на всех
  страницах одного прогона;
- filter[note_type][]=common уходит в каждый запрос.

Сеть подменяется фейковым httpx.AsyncClient, БД — фейковым conn с
fetchrow/executemany. Реальных сетевых вызовов и подключений к БД нет.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

import sources.amo_notes as amo_notes_module
from sources.amo_notes import NOTE_TYPE, OVERLAP_DAYS, AmoNotesSync


# ── Fakes ────────────────────────────────────────────────────────────────


class _FakeConn:
    """Заглушка asyncpg.Connection: fetchrow всегда отвечает про amo_notes,
    и падает, если кто-то вдруг обратится к external_sync_runs — это ровно
    то, что запрещено правкой watermark."""

    def __init__(self, ts=None):
        self.ts = ts
        self.fetchrow_calls: list[str] = []
        self.executemany_calls: list[tuple] = []

    async def fetchrow(self, query, *args):
        self.fetchrow_calls.append(query)
        if "external_sync_runs" in query:
            raise AssertionError(
                "_watermark не должен обращаться к external_sync_runs"
            )
        return {"ts": self.ts}

    async def executemany(self, query, rows):
        self.executemany_calls.append(rows)


class _FakeResponse:
    def __init__(self, status_code, payload=None):
        self.status_code = status_code
        self._payload = payload or {}

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


def _note(i: int) -> dict:
    return {
        "id": 9000 + i,
        "entity_id": 3000 + i,
        "entity_type": "leads",
        "note_type": NOTE_TYPE,
        "created_by": 1,
        "created_at": 1700000000 + i,
        "params": {"text": f"комментарий {i}"},
    }


class _AlwaysFullPageClient:
    """Каждая страница ровно PAGE_LIMIT комментариев — имитирует хвост
    данных, который не кончается раньше потолка MAX_PAGES."""

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url):
        page_limit = amo_notes_module.PAGE_LIMIT
        notes = [_note(i) for i in range(page_limit)]
        return _FakeResponse(200, {"_embedded": {"notes": notes}})


class _OnePartialPageClient:
    """Первая страница неполная — данные честно кончились сразу же."""

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url):
        notes = [_note(i) for i in range(2)]  # < PAGE_LIMIT
        return _FakeResponse(200, {"_embedded": {"notes": notes}})


class _RecordingClient:
    """Пишет запрошенные URL в общий список, чтобы проверить, что верхняя
    граница окна не меняется от страницы к странице. Первая страница полная,
    вторая — 204 (данные кончились)."""

    recorded_urls: list[str] = []

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url):
        type(self).recorded_urls.append(url)
        page_num = int(url.split("page=")[1].split("&")[0])
        if page_num == 1:
            page_limit = amo_notes_module.PAGE_LIMIT
            notes = [_note(i) for i in range(page_limit)]
            return _FakeResponse(200, {"_embedded": {"notes": notes}})
        return _FakeResponse(204)


def _patch_run_env(monkeypatch, max_pages: int, page_limit: int) -> None:
    monkeypatch.setattr(amo_notes_module, "MAX_PAGES", max_pages)
    monkeypatch.setattr(amo_notes_module, "PAGE_LIMIT", page_limit)
    monkeypatch.setattr(amo_notes_module, "TOKEN", "fake-token")
    monkeypatch.setattr(amo_notes_module, "BASE_URL", "https://example.amocrm.ru")
    monkeypatch.setattr(amo_notes_module, "INTER_PAGE_DELAY_SEC", 0)


# ── _watermark ───────────────────────────────────────────────────────────


async def test_watermark_falls_back_to_30_days_when_table_empty():
    conn = _FakeConn(ts=None)
    since = await AmoNotesSync()._watermark(conn)

    delta = datetime.now(timezone.utc) - since
    assert timedelta(days=29) < delta < timedelta(days=31)


async def test_watermark_uses_max_created_at_amo_minus_overlap():
    ts = datetime(2026, 7, 20, 12, 0, 0, tzinfo=timezone.utc)
    conn = _FakeConn(ts=ts)
    since = await AmoNotesSync()._watermark(conn)

    assert since == ts - timedelta(days=OVERLAP_DAYS)


async def test_watermark_never_queries_external_sync_runs():
    conn = _FakeConn(ts=None)
    await AmoNotesSync()._watermark(conn)

    assert len(conn.fetchrow_calls) == 1
    assert "amo_notes" in conn.fetchrow_calls[0]
    assert "created_at_amo" in conn.fetchrow_calls[0]


# ── run(): усечение по MAX_PAGES ────────────────────────────────────────


async def test_run_raises_when_max_pages_cap_is_hit(monkeypatch):
    _patch_run_env(monkeypatch, max_pages=3, page_limit=5)
    monkeypatch.setattr(amo_notes_module.httpx, "AsyncClient", _AlwaysFullPageClient)

    conn = _FakeConn(ts=None)
    with pytest.raises(RuntimeError, match=r"MAX_PAGES=3"):
        await AmoNotesSync().run(conn)

    # Всё, что успели загрузить до упора в потолок, должно быть закоммичено —
    # падение не должно откатывать уже сделанный upsert.
    assert len(conn.executemany_calls) == 3  # по одному INSERT на страницу


async def test_run_completes_normally_when_last_page_is_partial(monkeypatch):
    """Неполная последняя страница — это конец данных, а не усечение.
    Исключения быть не должно."""
    _patch_run_env(monkeypatch, max_pages=5, page_limit=5)
    monkeypatch.setattr(amo_notes_module.httpx, "AsyncClient", _OnePartialPageClient)

    conn = _FakeConn(ts=None)
    total = await AmoNotesSync().run(conn)

    assert total == 2


# ── run(): фиксированная верхняя граница окна ───────────────────────────


async def test_run_uses_fixed_upper_bound_across_pages(monkeypatch):
    """filter[created_at][to] считается один раз до цикла и не должен
    отличаться между страницами одного прогона — иначе множество, по
    которому идёт пагинация, "уезжает" под ногами."""
    _RecordingClient.recorded_urls = []
    _patch_run_env(monkeypatch, max_pages=5, page_limit=5)
    monkeypatch.setattr(amo_notes_module.httpx, "AsyncClient", _RecordingClient)

    conn = _FakeConn(ts=None)
    await AmoNotesSync().run(conn)

    urls = _RecordingClient.recorded_urls
    assert len(urls) == 2  # страница 1 (полная) + страница 2 (204 → стоп)

    to_values = {
        url.split("filter[created_at][to]=")[1].split("&")[0] for url in urls
    }
    assert all("filter[created_at][to]=" in url for url in urls)
    assert len(to_values) == 1  # одна и та же граница на всех страницах


async def test_run_filters_by_note_type_common_on_the_api_side(monkeypatch):
    """filter[note_type][]=common уходит в каждый запрос — остальные типы
    (звонки, системные сообщения) не должны даже скачиваться."""
    _RecordingClient.recorded_urls = []
    _patch_run_env(monkeypatch, max_pages=5, page_limit=5)
    monkeypatch.setattr(amo_notes_module.httpx, "AsyncClient", _RecordingClient)

    conn = _FakeConn(ts=None)
    await AmoNotesSync().run(conn)

    assert all(
        f"filter[note_type][]={NOTE_TYPE}" in url
        for url in _RecordingClient.recorded_urls
    )


def test_name_matches_sync_source_registry():
    # Должно совпадать с именем, зарегистрированным в CHECK
    # external_sync_runs.source (supabase/migrations/20260803_0003_amo_notes.sql)
    # — иначе log_run_start() в main.py уронит весь ночной цикл, а не один
    # источник.
    assert AmoNotesSync.name == "amo_notes"

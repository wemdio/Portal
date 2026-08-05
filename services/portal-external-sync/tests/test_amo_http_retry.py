"""Ретраи HTTP-запросов к AMO в AmoSync.

С 01.07 по 04.08.2026 источник amo_leads упал 8 раз из 52 прогонов, всегда
с одной ошибкой — «Server disconnected without sending a response.» (httpx
поднимает её как RemoteProtocolError). AMO рвёт соединение, синк сдаётся
после первой же попытки, и портал остаётся с данными вчерашней свежести,
а отчёты считаются по устаревшему снимку.

Здесь проверяется get_with_retry: повтор на обрыве связи и на 5xx, потолок
попыток, отсутствие лишних повторов на успешном ответе.

Сеть подменяется фейковым клиентом, паузы между попытками — фейковым sleep.
Реальных сетевых вызовов и ожиданий в тестах нет.
"""
from __future__ import annotations

import httpx
import pytest

import sources.amo as amo_module
from sources.amo import get_with_retry


class _FakeResponse:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload or {}

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                f"status {self.status_code}", request=None, response=None,
            )


class _ScriptedClient:
    """Отдаёт по сценарию: исключение — бросает, ответ — возвращает."""

    def __init__(self, script):
        self.script = list(script)
        self.calls = 0

    async def get(self, url):
        self.calls += 1
        item = self.script.pop(0) if self.script else _FakeResponse()
        if isinstance(item, Exception):
            raise item
        return item


@pytest.fixture(autouse=True)
def _no_real_sleep(monkeypatch):
    """Паузы между попытками не должны растягивать тесты на секунды."""
    slept: list[float] = []

    async def fake_sleep(seconds):
        slept.append(seconds)

    monkeypatch.setattr(amo_module.asyncio, "sleep", fake_sleep)
    return slept


async def test_повторяет_запрос_после_обрыва_соединения():
    client = _ScriptedClient([
        httpx.RemoteProtocolError("Server disconnected without sending a response."),
        _FakeResponse(200, {"ok": True}),
    ])

    resp = await get_with_retry(client, "https://amo/api/v4/leads")

    assert resp.json() == {"ok": True}
    assert client.calls == 2


async def test_сдаётся_после_трёх_попыток_и_пробрасывает_ошибку():
    client = _ScriptedClient([
        httpx.RemoteProtocolError("Server disconnected without sending a response."),
        httpx.RemoteProtocolError("Server disconnected without sending a response."),
        httpx.RemoteProtocolError("Server disconnected without sending a response."),
    ])

    with pytest.raises(httpx.RemoteProtocolError):
        await get_with_retry(client, "https://amo/api/v4/leads")

    assert client.calls == 3


async def test_повторяет_запрос_на_пятисотке_от_amo():
    client = _ScriptedClient([
        _FakeResponse(502),
        _FakeResponse(200, {"ok": True}),
    ])

    resp = await get_with_retry(client, "https://amo/api/v4/leads")

    assert resp.status_code == 200
    assert client.calls == 2


async def test_успешный_ответ_не_повторяется():
    client = _ScriptedClient([_FakeResponse(200, {"ok": True})])

    await get_with_retry(client, "https://amo/api/v4/leads")

    assert client.calls == 1


async def test_204_не_считается_ошибкой_и_не_повторяется():
    """AMO отдаёт 204 на пустой странице — это штатный конец пагинации."""
    client = _ScriptedClient([_FakeResponse(204)])

    resp = await get_with_retry(client, "https://amo/api/v4/leads")

    assert resp.status_code == 204
    assert client.calls == 1


class _FakeConn:
    """Заглушка asyncpg.Connection: запоминает, что и сколько раз записали."""

    def __init__(self):
        self.executemany_calls: list[tuple] = []

    async def executemany(self, query, rows):
        self.executemany_calls.append((query, rows))


class _AmoEndpointsClient:
    """Отвечает по эндпоинтам AMO. Первый запрос к /leads рвёт соединение —
    ровно так ведёт себя AMO в тех восьми падениях."""

    def __init__(self):
        self.calls: list[str] = []
        self.leads_disconnects_left = 1

    async def get(self, url):
        self.calls.append(url)
        if "/leads/pipelines" in url:
            return _FakeResponse(200, {"_embedded": {"pipelines": [
                {"id": 1, "name": "Воронка - новые лиды", "_embedded": {"statuses": [
                    {"id": 10, "name": "Первый контакт", "sort": 10,
                     "color": "#fff", "is_editable": True},
                ]}},
            ]}})
        if "/users" in url:
            return _FakeResponse(200, {"_embedded": {"users": [
                {"id": 7, "name": "Юлия Миронова", "email": "y@polza",
                 "rights": {"is_active": True}},
            ]}})
        if "/contacts" in url:
            return _FakeResponse(200, {"_embedded": {"contacts": []}})
        if "/companies" in url:
            return _FakeResponse(200, {"_embedded": {"companies": []}})
        if "/leads" in url:
            if self.leads_disconnects_left > 0:
                self.leads_disconnects_left -= 1
                raise httpx.RemoteProtocolError(
                    "Server disconnected without sending a response."
                )
            return _FakeResponse(200, {"_embedded": {"leads": [
                {"id": 555, "name": "Сделка", "pipeline_id": 1, "status_id": 10,
                 "responsible_user_id": 7, "price": 1000,
                 "created_at": 1700000000, "updated_at": 1700000000},
            ]}})
        raise AssertionError(f"неожиданный запрос: {url}")


async def test_синк_переживает_обрыв_соединения_на_странице_сделок(monkeypatch):
    monkeypatch.setattr(amo_module, "TOKEN", "t")
    monkeypatch.setattr(amo_module, "BASE_URL", "https://amo.test")
    client = _AmoEndpointsClient()
    monkeypatch.setattr(
        amo_module.httpx, "AsyncClient",
        lambda *a, **kw: _AsyncContext(client),
    )
    conn = _FakeConn()

    upserted = await amo_module.AmoSync().run(conn)

    assert upserted == 1
    assert client.leads_disconnects_left == 0


class _AsyncContext:
    def __init__(self, client):
        self.client = client

    async def __aenter__(self):
        return self.client

    async def __aexit__(self, *exc):
        return False


async def test_ждёт_между_попытками_с_нарастающей_паузой(_no_real_sleep):
    client = _ScriptedClient([
        httpx.RemoteProtocolError("boom"),
        httpx.RemoteProtocolError("boom"),
        _FakeResponse(200),
    ])

    await get_with_retry(client, "https://amo/api/v4/leads")

    assert _no_real_sleep == [2.0, 4.0]

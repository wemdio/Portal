"""Прогон Brocard (BrocardSync.run) — проводка целиком.

Отдельно от чистых функций (test_brocard_mapping.py): здесь проверяется то,
ради чего всё затевалось, — что источник честно листает страницы, читает обе
ручки, связывает комиссии с платежами и НЕ полагается на серверный фильтр по
карте, который на живом API не работает.

Сеть подменяется фейковым httpx.AsyncClient, БД — фейковым conn с executemany,
по образцу tests/test_bank_tbank_run.py. Реальных сетевых вызовов и подключений
к БД нет.
"""
from __future__ import annotations

import pytest

import sources.brocard as brocard
from sources.brocard import BROCARD_COLUMNS, BrocardSync

from tests.test_brocard_mapping import (
    DECLINED_PAYMENT,
    FOREIGN_CARD_RAW,
    FOREIGN_PAYMENT,
    OUR_CARD_RAW,
    OUR_PAYMENT,
)

API_KEY = "brocard-key-secret"


# ── Fakes ─────────────────────────────────────────────────────────────────


class _FakeConn:
    def __init__(self) -> None:
        self.upserted: list[tuple] = []

    async def executemany(self, query, rows):
        self.upserted.extend(rows)


class _FakeResponse:
    def __init__(self, payload: object) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> object:
        return self._payload


class _FakeClient:
    """Три ручки Brocard с настоящей пагинацией.

    balance_history раздаётся ОДИНАКОВО на любой card= — так ведёт себя
    сломанный серверный фильтр, который мы видели на /payments. Тесты ниже
    проверяют, что источник от этого не разъезжается.
    """

    cards: list[dict] = []
    payments: list[dict] = []
    movements: list[dict] = []
    fail_urls: set[str] = set()
    fail_cards: set[str] = set()
    requests: list[tuple[str, dict]] = []

    def __init__(self, *args, **kwargs) -> None:
        self.headers = kwargs.get("headers", {})

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, params=None):
        cls = type(self)
        cls.requests.append((url, dict(params or {})))
        if url in cls.fail_urls:
            raise RuntimeError("connect timeout")
        if str((params or {}).get("card") or "") in cls.fail_cards:
            raise RuntimeError("card history exploded")

        data = {
            brocard.CARDS_URL: cls.cards,
            brocard.PAYMENTS_URL: cls.payments,
            brocard.BALANCE_HISTORY_URL: cls.movements,
        }[url]

        per_page = int(params["per_page"])
        page = int(params["page"])
        chunk = data[(page - 1) * per_page : page * per_page]
        last_page = max(1, -(-len(data) // per_page))
        return _FakeResponse(
            {
                "data": chunk,
                "total": len(data),
                "per_page": per_page,
                "current_page": page,
                "last_page": last_page,
            }
        )


def _movement(**overrides) -> dict:
    mv = {
        "transaction_id": 501,
        "date": "2026-07-31T09:42:35+03:00",
        "account": "ХОНГ Покупки",
        "account_number": "450897******7788",
        "currency": "usd",
        "amount": "-0.88",
        "direction": "outcome",
        "type": "payment_fee",
        "based_on_type": "payment",
        "based_on_id": OUR_PAYMENT["id"],
        "description": "Payment fee",
    }
    mv.update(overrides)
    return mv


#: Движение чужой карты: приезжает в ответ на card=<наша>, опознаётся только
#: по карте связанного платежа.
FOREIGN_MOVEMENT = _movement(
    transaction_id=900,
    account="фб 5",
    account_number="450897******5634",
    based_on_id=FOREIGN_PAYMENT["id"],
)


@pytest.fixture(autouse=True)
def _isolated_run(monkeypatch):
    monkeypatch.setattr(brocard.httpx, "AsyncClient", _FakeClient)
    monkeypatch.setattr(_FakeClient, "cards", [FOREIGN_CARD_RAW, OUR_CARD_RAW])
    monkeypatch.setattr(_FakeClient, "payments", [FOREIGN_PAYMENT, OUR_PAYMENT, DECLINED_PAYMENT])
    monkeypatch.setattr(_FakeClient, "movements", [_movement()])
    monkeypatch.setattr(_FakeClient, "fail_urls", set())
    monkeypatch.setattr(_FakeClient, "fail_cards", set())
    monkeypatch.setattr(_FakeClient, "requests", [])
    monkeypatch.setenv(brocard.API_KEY_ENV, API_KEY)
    monkeypatch.delenv(brocard.CARD_TITLE_ENV, raising=False)


def _column(conn: _FakeConn, name: str) -> list:
    idx = BROCARD_COLUMNS.index(name)
    return [row[idx] for row in conn.upserted]


# ── Ключ и карта ──────────────────────────────────────────────────────────


async def test_without_api_key_source_reports_not_implemented(monkeypatch):
    """Контракт со скелетом сохранён: main.py пишет прогон как partial и идёт
    дальше, а не роняет весь синк."""
    monkeypatch.delenv(brocard.API_KEY_ENV, raising=False)
    with pytest.raises(NotImplementedError, match="BROCARD_API_KEY"):
        await BrocardSync().run(_FakeConn())


async def test_missing_card_names_the_available_titles(monkeypatch):
    """Название карты — конфиг, который человек может опечатать; ошибка обязана
    чиниться с первого раза, а не по логам чужого API."""
    monkeypatch.setenv(brocard.CARD_TITLE_ENV, "ХОНГ Покупкi")

    with pytest.raises(RuntimeError) as exc:
        await BrocardSync().run(_FakeConn())

    assert "ХОНГ Покупки" in str(exc.value)
    assert "фб 5" in str(exc.value)


async def test_api_key_goes_into_the_authorization_header(monkeypatch):
    captured: dict = {}

    class _CapturingClient(_FakeClient):
        def __init__(self, *args, **kwargs):
            captured.update(kwargs.get("headers", {}))
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(brocard.httpx, "AsyncClient", _CapturingClient)
    await BrocardSync().run(_FakeConn())
    assert captured["Authorization"] == f"Bearer {API_KEY}"


# ── Пагинация ─────────────────────────────────────────────────────────────


async def test_all_pages_are_walked(monkeypatch):
    """На живой карте 232 операции и три страницы — остановка на первой тихо
    потеряла бы две трети расходов."""
    monkeypatch.setattr(brocard, "PER_PAGE", 2)
    monkeypatch.setattr(
        _FakeClient,
        "movements",
        [_movement(transaction_id=n, based_on_id=OUR_PAYMENT["id"]) for n in range(1, 6)],
    )

    conn = _FakeConn()
    total = await BrocardSync().run(conn)

    assert total == 5
    assert sorted(_column(conn, "external_id")) == ["1", "2", "3", "4", "5"]
    history_pages = [
        p["page"] for url, p in _FakeClient.requests if url == brocard.BALANCE_HISTORY_URL
    ]
    assert history_pages == [1, 2, 3]


async def test_payments_are_fetched_without_a_card_filter():
    """Серверный фильтр по карте проверен и не работает, а полный индекс
    платежей нужен ещё и затем, чтобы опознавать чужие карты."""
    await BrocardSync().run(_FakeConn())
    payment_params = [p for url, p in _FakeClient.requests if url == brocard.PAYMENTS_URL]
    assert payment_params
    assert all("card" not in p for p in payment_params)


# ── Отбор по карте ────────────────────────────────────────────────────────


async def test_foreign_card_movement_never_reaches_the_database(monkeypatch, capsys):
    """Главный тест: фейковый API отдаёт историю целиком, игнорируя card=,
    ровно как живой /payments. Чужая строка обязана отсеяться на нашей
    стороне, а факт неработающего фильтра — попасть в лог."""
    monkeypatch.setattr(_FakeClient, "movements", [_movement(), FOREIGN_MOVEMENT])

    conn = _FakeConn()
    total = await BrocardSync().run(conn)

    assert total == 1
    assert _column(conn, "external_id") == ["501"]
    assert _column(conn, "card_id") == ["2660444"]

    logged = capsys.readouterr().out
    assert "серверный фильтр card= НЕ работает" in logged
    assert "foreign_card=1" in logged


async def test_unprovable_movement_is_skipped_loudly(monkeypatch, capsys):
    """Ни платежа в индексе, ни совпадения по account/account_number.
    Записать такое движение значило бы, возможно, записать чужую трату;
    громкий пропуск виден в сводке, молчаливая запись — нет."""
    orphan = _movement(
        transaction_id=777,
        account="Неизвестно",
        account_number="450897******0001",
        based_on_id=999999,
        type="declined_payment_fee",
    )
    monkeypatch.setattr(_FakeClient, "movements", [orphan])

    conn = _FakeConn()
    total = await BrocardSync().run(conn)

    assert total == 0
    assert conn.upserted == []
    assert "card_unverified:declined_payment_fee=1" in capsys.readouterr().out


async def test_two_cards_with_the_same_title_do_not_double_count(monkeypatch):
    """Обе карты с нужным названием синкаются, но одна и та же строка истории,
    приехавшая на оба запроса (сломанный фильтр), пишется один раз."""
    second_card = {**OUR_CARD_RAW, "id": 2660445, "last_four": "9900"}
    monkeypatch.setattr(_FakeClient, "cards", [OUR_CARD_RAW, second_card])

    conn = _FakeConn()
    total = await BrocardSync().run(conn)

    assert total == 1
    assert _column(conn, "external_id") == ["501"]


# ── Связь и суммы на проводке ─────────────────────────────────────────────


async def test_fee_lands_positive_with_the_merchant_of_its_payment(capsys):
    conn = _FakeConn()
    await BrocardSync().run(conn)

    assert _column(conn, "amount") == [0.88]
    assert _column(conn, "currency") == ["USD"]
    assert _column(conn, "merchant") == ["Facebook"]
    assert _column(conn, "operation_type") == ["payment_fee"]
    assert "linked_by_payment=1" in capsys.readouterr().out


async def test_void_lands_negative_and_unknown_income_is_only_counted(
    monkeypatch, capsys
):
    """Возврат гасит трату (минус), незнакомый приход не вычитается вовсе —
    иначе будущее пополнение карты занизило бы расходы."""
    monkeypatch.setattr(
        _FakeClient,
        "movements",
        [
            _movement(transaction_id=1, amount="-17.00", type="payment"),
            _movement(
                transaction_id=2, amount="17.00", direction="income", type="payment_void"
            ),
            _movement(
                transaction_id=3, amount="500.00", direction="income", type="card_topup"
            ),
        ],
    )

    conn = _FakeConn()
    total = await BrocardSync().run(conn)

    assert total == 2
    assert _column(conn, "amount") == [17.00, -17.00]
    assert sum(_column(conn, "amount")) == 0

    logged = capsys.readouterr().out
    assert "unknown_income_type:card_topup=1" in logged
    assert "ВНИМАНИЕ: незнакомые типы прихода не учтены" in logged


# ── Изоляция сбоев ────────────────────────────────────────────────────────


async def test_failing_card_does_not_take_out_the_others(monkeypatch, capsys):
    """Единица работы — карта: сбой истории одной не должен унести остальные,
    источник обязан дойти до конца и залить то, что удалось."""
    second_card = {**OUR_CARD_RAW, "id": 2660445, "last_four": "9900"}
    monkeypatch.setattr(_FakeClient, "cards", [OUR_CARD_RAW, second_card])
    monkeypatch.setattr(_FakeClient, "fail_cards", {"2660444"})

    conn = _FakeConn()
    total = await BrocardSync().run(conn)

    assert total == 1
    assert "card FAIL id=2660444" in capsys.readouterr().out
    # Принадлежность движения определяется картой связанного платежа, а не
    # тем, чей запрос принёс строку. Поэтому уцелевшая строка правильно
    # приписана карте 2660444, хотя приехала ответом на запрос по 2660445 —
    # ровно то, ради чего отбор сделан на нашей стороне.
    assert _column(conn, "card_id") == ["2660444"]


async def test_failing_cards_request_is_not_swallowed(monkeypatch):
    """А вот сбой самого списка карт — это ошибка прогона (main.py запишет
    'error'), а не «синкать нечего»: молча вернуть 0 значило бы выдать
    пустой день за день без трат."""
    monkeypatch.setattr(_FakeClient, "fail_urls", {brocard.CARDS_URL})
    with pytest.raises(RuntimeError, match="connect timeout"):
        await BrocardSync().run(_FakeConn())


async def test_summary_prints_the_type_distribution(monkeypatch, capsys):
    monkeypatch.setattr(
        _FakeClient,
        "movements",
        [
            _movement(transaction_id=1, type="payment"),
            _movement(transaction_id=2, type="payment_fee"),
            _movement(transaction_id=3, type="payment_fee"),
        ],
    )

    await BrocardSync().run(_FakeConn())

    logged = capsys.readouterr().out
    assert "type:payment=1" in logged
    assert "type:payment_fee=2" in logged

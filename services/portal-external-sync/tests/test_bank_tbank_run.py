"""Прогон Т-Банка по нескольким токенам и счетам (BankTBankSync.run).

Отдельно от чистых функций (test_bank_tbank_accounts.py — токены и разбор
счетов, test_bank_mapping.py — маппинг операций): здесь проверяется сама
проводка, ради которой всё это затевалось, — что источник идёт по всем
токенам и по всем счетам каждого токена, и что сбой одного не уносит
остальные.

Сеть подменяется фейковым httpx.AsyncClient, БД — фейковым conn с
executemany, по образцу tests/test_amo_events_sync.py. Реальных сетевых
вызовов и подключений к БД нет.
"""
from __future__ import annotations

import pytest

import sources.bank_tbank as tbank
from sources.bank_tbank import BankTBankSync

TOKEN_1 = "token-one-secret"
TOKEN_2 = "token-two-secret"

ACC_1 = "40802810600001780269"
ACC_2A = "40702810000000000001"
ACC_2B = "40702810000000000002"

ACCOUNTS_BY_TOKEN = {
    TOKEN_1: [{"accountNumber": ACC_1, "currency": "643"}],
    TOKEN_2: [
        {"accountNumber": ACC_2A, "currency": "643"},
        {"accountNumber": ACC_2B, "currency": "643"},
    ],
}


# ── Fakes ─────────────────────────────────────────────────────────────────


class _FakeConn:
    def __init__(self) -> None:
        self.upserted: list[tuple] = []

    async def executemany(self, query, rows):
        self.upserted.extend(rows)


class _FakeResponse:
    def __init__(self, status_code: int, payload: object = None) -> None:
        self.status_code = status_code
        self._payload = payload

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self) -> object:
        return self._payload


def _operation(account: str, op_id: str) -> dict:
    """Приход на указанный счёт — минимальный набор полей, который
    map_operation считает пригодным."""
    return {
        "operationId": op_id,
        "id": 1,
        "date": "2026-07-15",
        "amount": 100,
        "recipientAccount": account,
        "payerName": "ООО Клиент",
        "payerInn": "7701234567",
        "paymentPurpose": "Оплата по счёту",
    }


class _FakeClient:
    """Раздаёт счета и выписки по токену из заголовка Authorization.

    accounts_error, если задан для токена, — исключение, которым падает
    запрос списка счетов этого токена.
    """

    accounts_error: dict[str, Exception] = {}
    accounts_override: dict[str, object] = {}

    def __init__(self, *args, **kwargs) -> None:
        self.token = kwargs["headers"]["Authorization"].removeprefix("Bearer ")

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, params=None):
        if url == tbank.ACCOUNTS_URL:
            error = type(self).accounts_error.get(self.token)
            if error is not None:
                raise error
            payload = type(self).accounts_override.get(
                self.token, ACCOUNTS_BY_TOKEN[self.token]
            )
            return _FakeResponse(200, payload)

        account = params["accountNumber"]
        return _FakeResponse(
            200, {"operation": [_operation(account, f"op-{account}")]}
        )


@pytest.fixture(autouse=True)
def _isolated_run(monkeypatch):
    """Один период вместо четырёх (иначе каждый счёт синкался бы 4 раза и
    арифметика в тестах стала бы про PERIODS, а не про счета), чистые
    словари фейкового клиента и пустое окружение по умолчанию."""
    monkeypatch.setattr(tbank, "PERIODS", [("2026-01-01", "2026-07-31")])
    monkeypatch.setattr(tbank.httpx, "AsyncClient", _FakeClient)
    monkeypatch.setattr(_FakeClient, "accounts_error", {})
    monkeypatch.setattr(_FakeClient, "accounts_override", {})
    for name in tbank.TOKEN_ENV_VARS:
        monkeypatch.delenv(name, raising=False)


def _account_ids(conn: _FakeConn) -> list[str]:
    """account_id из залитых строк — вторая колонка BANK_COLUMNS."""
    return [row[1] for row in conn.upserted]


# ── Токены и счета ────────────────────────────────────────────────────────


async def test_no_token_at_all_is_not_implemented(monkeypatch):
    """Тот же контракт, что раньше был у единственного TBANK_TOKEN: источник
    не «падает», а сообщает main.py, что синкать нечем (partial, не error)."""
    with pytest.raises(NotImplementedError, match="TBANK_TOKEN"):
        await BankTBankSync().run(_FakeConn())


async def test_only_first_token_syncs_only_its_accounts(monkeypatch):
    """Второй бизнес не заведён — поведение ровно как до правки: один токен,
    его счета, ничего лишнего."""
    monkeypatch.setenv("TBANK_TOKEN", TOKEN_1)

    conn = _FakeConn()
    total = await BankTBankSync().run(conn)

    assert total == 1
    assert _account_ids(conn) == [ACC_1]


async def test_both_tokens_and_all_their_accounts_are_synced(monkeypatch):
    monkeypatch.setenv("TBANK_TOKEN", TOKEN_1)
    monkeypatch.setenv("TBANK_TOKEN_2", TOKEN_2)

    conn = _FakeConn()
    total = await BankTBankSync().run(conn)

    assert total == 3
    assert _account_ids(conn) == [ACC_1, ACC_2A, ACC_2B]


async def test_currency_of_the_account_lands_in_the_row(monkeypatch):
    """currency — седьмая колонка BANK_COLUMNS; она обязана прийти со счёта,
    а не из константы."""
    monkeypatch.setenv("TBANK_TOKEN", TOKEN_1)
    monkeypatch.setattr(
        _FakeClient,
        "accounts_override",
        {TOKEN_1: [{"accountNumber": ACC_1, "currency": "840"}]},
    )

    conn = _FakeConn()
    await BankTBankSync().run(conn)

    assert [row[6] for row in conn.upserted] == ["USD"]


# ── Изоляция сбоев ────────────────────────────────────────────────────────


async def test_failed_accounts_request_skips_only_that_token(monkeypatch, capsys):
    """Если список счетов для токена не получен — логируем и идём к
    следующему токену, а не роняем весь источник."""
    monkeypatch.setenv("TBANK_TOKEN", TOKEN_1)
    monkeypatch.setenv("TBANK_TOKEN_2", TOKEN_2)
    monkeypatch.setattr(
        _FakeClient, "accounts_error", {TOKEN_2: RuntimeError("connect timeout")}
    )

    conn = _FakeConn()
    total = await BankTBankSync().run(conn)

    assert total == 1
    assert _account_ids(conn) == [ACC_1]

    logged = capsys.readouterr().out
    assert "TBANK_TOKEN_2" in logged
    assert "не удалось получить список счетов" in logged


async def test_token_without_any_account_is_logged_and_skipped(monkeypatch, capsys):
    monkeypatch.setenv("TBANK_TOKEN", TOKEN_1)
    monkeypatch.setenv("TBANK_TOKEN_2", TOKEN_2)
    monkeypatch.setattr(_FakeClient, "accounts_override", {TOKEN_2: []})

    conn = _FakeConn()
    total = await BankTBankSync().run(conn)

    assert total == 1
    logged = capsys.readouterr().out
    assert "TBANK_TOKEN_2: банк не вернул ни одного пригодного счёта" in logged


async def test_failing_period_does_not_take_out_the_other_accounts(
    monkeypatch, capsys
):
    """Третий уровень изоляции: сбой периода одного счёта не должен унести
    остальные счета того же токена."""
    monkeypatch.setenv("TBANK_TOKEN_2", TOKEN_2)

    original_get = _FakeClient.get

    async def flaky_get(self, url, params=None):
        if params is not None and params["accountNumber"] == ACC_2A:
            raise RuntimeError("statement exploded")
        return await original_get(self, url, params)

    monkeypatch.setattr(_FakeClient, "get", flaky_get)

    conn = _FakeConn()
    total = await BankTBankSync().run(conn)

    assert total == 1
    assert _account_ids(conn) == [ACC_2B]
    assert "period FAIL" in capsys.readouterr().out


async def test_token_value_never_reaches_the_log(monkeypatch, capsys):
    """Даже если значение токена попало в текст исключения, в лог оно уйти
    не должно — токен опознаётся именем переменной окружения."""
    monkeypatch.setenv("TBANK_TOKEN", TOKEN_1)
    monkeypatch.setattr(
        _FakeClient,
        "accounts_error",
        {TOKEN_1: RuntimeError(f"401 for Bearer {TOKEN_1}")},
    )

    await BankTBankSync().run(_FakeConn())

    logged = capsys.readouterr().out
    assert TOKEN_1 not in logged
    assert "<redacted>" in logged
    assert "TBANK_TOKEN" in logged

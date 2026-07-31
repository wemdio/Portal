"""Разбор ответа TronGrid: запись TRC-20 → строка crypto_income_transfers.

Образцы — не выдуманные, а снятые с живого api.trongrid.io 31.07.2026 (ручка
GET /v1/accounts/{address}/transactions/trc20, набор ключей записи полный).
Изменён в них ровно один ключ — `to`: в живой выборке там стоял адрес,
по которому запрос и делался, а здесь стоит тестовый адрес кошелька. Сам
адрес кошелька студии в репозитории не лежит, он приезжает из окружения
(TRON_USDT_WALLET_ADDRESS), поэтому тут заведомо тестовая строка.

Логика вынесена в чистые функции (map_transfer, parse_transfer_amount,
parse_block_timestamp, build_transfer_id) именно ради этих тестов: run()
ходит в сеть и в юните непроверяем — тот же приём, что у банковских
источников.
"""
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from sources._bank_common import parse_date
from sources.crypto_usdt import (
    USDT_TRC20_CONTRACT,
    build_transfer_id,
    map_transfer,
    parse_block_timestamp,
    parse_transfer_amount,
)

MSK = timezone(timedelta(hours=3))

#: Кошелёк-получатель в образцах. Заведомо тестовая строка — настоящий адрес
#: живёт только в окружении.
WALLET = "TWalletForTestsOnly1111111111111111"

TOKEN_INFO = {
    "symbol": "USDT",
    "address": USDT_TRC20_CONTRACT,
    "decimals": 6,
    "name": "Tether USD",
}

#: Живая запись, как есть (кроме `to`). value — СТРОКА минимальных единиц:
#: "10000000000" при decimals=6 это 10 000 USDT. block_timestamp — целое
#: число МИЛЛИСЕКУНД: 1785511209000 = 2026-07-31 15:20:09 UTC.
TRANSFER = {
    "transaction_id": "e37eb34143ca601453464d8ab9bc75f210f9529204353afd2adc112d27110211",
    "token_info": TOKEN_INFO,
    "block_timestamp": 1785511209000,
    "from": "TJpNLFmEc6TKPauE4AQpEcsZ6ngrgrL783",
    "to": WALLET,
    "type": "Transfer",
    "value": "10000000000",
}

#: Вторая живая запись той же выборки — другой отправитель, другая сумма.
TRANSFER_2 = {
    "transaction_id": "83d5aef9fad646e5000258c78d668adfc61f6490c59f38be8951ce680d606553",
    "token_info": TOKEN_INFO,
    "block_timestamp": 1785510885000,
    "from": "THGpMZQTkrS3K22EdjqXi6TuJgmgNsoXMQ",
    "to": WALLET,
    "type": "Transfer",
    "value": "30195000000",
}

#: Approval из той же живой выборки: в 200 записях с only_to=true их пришло 5.
#: Денег не приносит, но `value` у него есть — без фильтра по type лёг бы
#: выдуманным доходом.
APPROVAL = {
    "transaction_id": "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    "token_info": TOKEN_INFO,
    "block_timestamp": 1785511209000,
    "from": "TJpNLFmEc6TKPauE4AQpEcsZ6ngrgrL783",
    "to": WALLET,
    "type": "Approval",
    "value": "115792089237316195423570985008687907853269984665640564039457584007913129639935",
}

#: Реальная транзакция мейннета с ДВУМЯ переводами токена внутри — снята с
#: соседней ручки /v1/contracts/{contract}/events, где у неё два Transfer-лога
#: с event_index 0 и 1 и суммами 1500000 и 37500000 (1.5 и 37.5 USDT).
#: Получатели там разные; здесь оба переведены на наш кошелёк — это и есть
#: случай, ради которого уникальность в таблице сделана по переводу, а не по
#: транзакции. Сама ручка /accounts/…/transactions/trc20 event_index не
#: отдаёт, поэтому различить логи можно только по содержимому.
MULTI_TRANSFER_TX = "e853aabefb59e66d8a4df19cb1b78ea198216b1d075e6cddba614591e9535203"
MULTI_A = {
    "transaction_id": MULTI_TRANSFER_TX,
    "token_info": TOKEN_INFO,
    "block_timestamp": 1785514095000,
    "from": "TJpNLFmEc6TKPauE4AQpEcsZ6ngrgrL783",
    "to": WALLET,
    "type": "Transfer",
    "value": "1500000",
}
MULTI_B = {**MULTI_A, "value": "37500000"}


# ── Сумма ────────────────────────────────────────────────────────────────


def test_real_amount_is_scaled_by_decimals():
    """"10000000000" при decimals=6 — это 10 000 USDT, а не десять миллиардов."""
    assert parse_transfer_amount("10000000000", 6) == Decimal("10000")
    assert parse_transfer_amount("30195000000", 6) == Decimal("30195")


def test_six_decimal_places_survive_exactly():
    """Шесть знаков после запятой обязаны дойти без потерь: у USDT
    decimals=6, и на float такие суммы уже врут в последнем знаке."""
    assert parse_transfer_amount("30195123456", 6) == Decimal("30195.123456")
    assert parse_transfer_amount("1", 6) == Decimal("0.000001")
    # Именно Decimal, а не float: сравнение ниже на float не сошлось бы.
    assert parse_transfer_amount("1500000", 6) == Decimal("1.5")


def test_missing_amount_is_not_a_silent_zero():
    assert parse_transfer_amount(None, 6) is None
    assert parse_transfer_amount("не число", 6) is None


def test_missing_decimals_is_rejected():
    """Без decimals масштаб суммы неизвестен — угадывать 6 нельзя."""
    assert parse_transfer_amount("10000000000", None) is None
    assert parse_transfer_amount("10000000000", "6") is None


def test_negative_amount_is_rejected():
    """value — uint256, минус означает испорченный ответ, а не расход."""
    assert parse_transfer_amount("-1000000", 6) is None


# ── Дата ─────────────────────────────────────────────────────────────────


def test_block_timestamp_is_milliseconds_utc():
    """1785511209000 — миллисекунды от эпохи, а не секунды и не строка."""
    assert parse_block_timestamp(1785511209000) == datetime(
        2026, 7, 31, 15, 20, 9, tzinfo=timezone.utc
    )


def test_common_bank_parser_cannot_read_this_format():
    """Регрессия на общий parse_date из _bank_common: он режет аргумент до 19
    символов и штампует UTC, то есть на числовой метке в миллисекундах даёт
    None. Ради этого у крипты собственный разбор даты."""
    assert parse_date(1785511209000) is None
    assert parse_date(str(1785511209000)) is None


def test_evening_moment_keeps_its_moscow_date():
    """Вечерняя операция не должна уезжать на соседние сутки. 23:45 МСК
    31 июля — это 20:45 UTC того же дня; в базу уходит UTC, в московскую дату
    его переводит витрина (AT TIME ZONE 'Europe/Moscow')."""
    parsed = parse_block_timestamp(1785530700000)
    assert parsed == datetime(2026, 7, 31, 20, 45, tzinfo=timezone.utc)
    assert parsed.astimezone(MSK).date().isoformat() == "2026-07-31"


def test_broken_timestamp_is_rejected():
    assert parse_block_timestamp(None) is None
    assert parse_block_timestamp("вчера") is None
    assert parse_block_timestamp(0) is None
    assert parse_block_timestamp(-1) is None


# ── Маппинг записи целиком ───────────────────────────────────────────────


def test_real_transfer_maps_to_full_row():
    row = map_transfer(TRANSFER, WALLET)
    assert row is not None
    assert row["transaction_id"] == TRANSFER["transaction_id"]
    assert row["network"] == "tron"
    assert row["token_symbol"] == "USDT"
    assert row["token_contract"] == USDT_TRC20_CONTRACT
    assert row["wallet_address"] == WALLET
    assert row["from_address"] == "TJpNLFmEc6TKPauE4AQpEcsZ6ngrgrL783"
    assert row["amount"] == Decimal("10000")
    assert row["currency"] == "USDT"
    assert row["occurred_at"] == datetime(2026, 7, 31, 15, 20, 9, tzinfo=timezone.utc)


def test_raw_keeps_the_original_record():
    import json

    row = map_transfer(TRANSFER_2, WALLET)
    assert json.loads(row["raw"]) == TRANSFER_2


def test_approval_is_skipped():
    """Реальный случай выборки: Approval денег не приносит, но `value` несёт."""
    skips: dict[str, int] = {}
    assert map_transfer(APPROVAL, WALLET, skips) is None
    assert skips == {"not_a_transfer": 1}


def test_foreign_token_contract_is_skipped():
    """Символ токена в блокчейне не защищён — скам-контракт может назваться
    USDT. Доверяем адресу контракта, а не символу."""
    scam = {
        **TRANSFER,
        "token_info": {**TOKEN_INFO, "address": "TScamContractLookAlike00000000000000"},
    }
    skips: dict[str, int] = {}
    assert map_transfer(scam, WALLET, skips) is None
    assert skips == {"other_token": 1}


def test_outgoing_transfer_is_skipped():
    """only_to=true это и так гарантирует; если параметр когда-нибудь
    потеряется, исходящий перевод не должен стать приходом."""
    outgoing = {**TRANSFER, "to": "TSomeoneElseAddress000000000000000"}
    skips: dict[str, int] = {}
    assert map_transfer(outgoing, WALLET, skips) is None
    assert skips == {"not_incoming": 1}


def test_transfer_without_sender_is_skipped():
    """Отправитель — единственный контрагент, который у крипты есть."""
    skips: dict[str, int] = {}
    assert map_transfer({**TRANSFER, "from": None}, WALLET, skips) is None
    assert skips == {"no_from": 1}


def test_transfer_without_tx_id_is_skipped():
    skips: dict[str, int] = {}
    assert map_transfer({**TRANSFER, "transaction_id": ""}, WALLET, skips) is None
    assert skips == {"no_tx_id": 1}


def test_unparsable_amount_is_skipped():
    skips: dict[str, int] = {}
    assert map_transfer({**TRANSFER, "value": "много"}, WALLET, skips) is None
    assert skips == {"bad_amount": 1}


def test_unparsable_date_is_skipped():
    skips: dict[str, int] = {}
    assert map_transfer({**TRANSFER, "block_timestamp": "вчера"}, WALLET, skips) is None
    assert skips == {"bad_date": 1}


def test_bad_record_does_not_take_the_good_ones_with_it():
    """Пропуск одной непригодной записи не мешает разобрать остальные —
    страница обязана дойти до конца."""
    skips: dict[str, int] = {}
    page = [TRANSFER, APPROVAL, {**TRANSFER_2, "value": None}, MULTI_A]
    rows = [r for r in (map_transfer(t, WALLET, skips) for t in page) if r is not None]
    assert len(rows) == 2
    assert skips == {"not_a_transfer": 1, "bad_amount": 1}


# ── Идентификатор перевода ───────────────────────────────────────────────


def test_two_transfers_of_one_transaction_get_different_ids():
    """Главное свойство ключа: в одной транзакции блокчейна бывает несколько
    переводов токена, и уникальность по transaction_id схлопнула бы их в одну
    строку, молча потеряв деньги."""
    row_a = map_transfer(MULTI_A, WALLET)
    row_b = map_transfer(MULTI_B, WALLET)
    assert row_a["transaction_id"] == row_b["transaction_id"] == MULTI_TRANSFER_TX
    assert row_a["transfer_id"] != row_b["transfer_id"]
    assert row_a["amount"] == Decimal("1.5")
    assert row_b["amount"] == Decimal("37.5")


def test_transfer_id_is_stable_across_runs():
    """Ключ обязан быть одним и тем же при каждом прогоне — иначе UPSERT
    наплодит дубли вместо обновления. Поэтому он собран из содержимого, а не
    из позиции записи в ответе."""
    assert build_transfer_id(TRANSFER) == build_transfer_id(dict(TRANSFER))
    assert build_transfer_id(TRANSFER) != build_transfer_id(TRANSFER_2)


def test_transfer_id_carries_the_transaction_hash():
    """Хеш транзакции внутри ключа — чтобы по строке базы можно было дойти до
    перевода в обозревателе блоков."""
    assert build_transfer_id(TRANSFER).startswith(TRANSFER["transaction_id"] + ":")

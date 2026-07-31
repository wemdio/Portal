"""Токены и счета Т-Банка (sources/bank_tbank.py).

У студии больше одного бизнеса в Т-Банке, у каждого свой токен. Номера счетов
не задаются конфигом и никогда не задавались осмысленно: раньше номер был
константой в исходнике (`ACCOUNT = os.environ.get("TBANK_ACCOUNT", "4080…")`,
переменной в окружении не было), и второму бизнесу она не подошла бы — это
счёт первого. Теперь счета спрашиваются у самого банка.

Разбор ответа /bank-accounts вынесен в чистую функцию parse_accounts именно
ради этих тестов: сетевая часть (run) в юните непроверяема, а образец ответа
снят с живого API 31.07.2026 и лежит здесь как SAMPLE_ACCOUNTS.
"""
from sources.bank_tbank import (
    CURRENCY_BY_NUMERIC_CODE,
    TOKEN_ENV_VARS,
    BankAccount,
    currency_from_numeric_code,
    load_tokens,
    parse_accounts,
    redact_tokens,
)

# Живой ответ GET /openapi/api/v1/bank-accounts за первый токен, 31.07.2026:
# голый массив, счёт ровно один, и это тот самый номер, что раньше был
# захардкожен в исходнике — поэтому для первого бизнеса поведение не меняется.
SAMPLE_ACCOUNTS = [
    {
        "accountNumber": "40802810600001780269",
        "currency": "643",
        "balance": {
            "otb": 456529.5,
            "authorized": 0,
            "pendingPayments": 0,
            "pendingRequisitions": 0,
        },
    }
]


# ── Токены списком ────────────────────────────────────────────────────────


def test_first_token_alone_is_enough():
    assert load_tokens({"TBANK_TOKEN": "t1"}) == [("TBANK_TOKEN", "t1")]


def test_second_token_is_picked_up_in_declared_order():
    tokens = load_tokens({"TBANK_TOKEN": "t1", "TBANK_TOKEN_2": "t2"})
    assert tokens == [("TBANK_TOKEN", "t1"), ("TBANK_TOKEN_2", "t2")]


def test_empty_and_blank_tokens_are_dropped():
    assert load_tokens({"TBANK_TOKEN": "  ", "TBANK_TOKEN_2": " t2 "}) == [
        ("TBANK_TOKEN_2", "t2")
    ]


def test_no_tokens_at_all_yields_empty_list():
    """Пустой список — сигнал вызывающему поднять NotImplementedError, как
    раньше делал гейт на отсутствие единственного токена."""
    assert load_tokens({}) == []


def test_adding_a_third_business_is_one_line():
    """Список имён переменных — единственное место, где перечислены токены;
    третий бизнес добавляется дописыванием имени сюда."""
    assert TOKEN_ENV_VARS == ("TBANK_TOKEN", "TBANK_TOKEN_2")


def test_token_values_are_redacted_from_log_text():
    """Значение токена не должно попасть в лог ни при каких ошибках — тексты
    исключений и трейсбеки прогоняются через redact_tokens."""
    env = {"TBANK_TOKEN": "secret-one", "TBANK_TOKEN_2": "secret-two"}
    text = "HTTP 401 for Bearer secret-one and Bearer secret-two"
    redacted = redact_tokens(text, env)
    assert "secret-one" not in redacted
    assert "secret-two" not in redacted
    assert redacted.count("<redacted>") == 2


# ── Код валюты ────────────────────────────────────────────────────────────


def test_known_numeric_codes_map_to_letters():
    assert currency_from_numeric_code("643") == "RUB"
    assert currency_from_numeric_code("840") == "USD"
    assert currency_from_numeric_code("978") == "EUR"


def test_numeric_code_may_arrive_as_int():
    assert currency_from_numeric_code(643) == "RUB"


def test_numeric_code_is_matched_ignoring_surrounding_spaces():
    assert currency_from_numeric_code(" 643 ") == "RUB"


def test_short_numeric_code_is_zero_padded(monkeypatch):
    """ISO 4217 — трёхзначный код: "8" и "008" это одна и та же валюта.

    Ни один код из таблицы сегодня не короче трёх знаков, поэтому путь
    проверяется на временно подставленной записи — иначе тест был бы
    сравнением двух None и ничего бы не проверял.
    """
    monkeypatch.setitem(CURRENCY_BY_NUMERIC_CODE, "008", "ALL")
    assert currency_from_numeric_code("8") == "ALL"
    assert currency_from_numeric_code("008") == "ALL"


def test_unknown_code_is_none_not_rub():
    """Главный тест: неизвестный код не должен превращаться в рубль.
    Молчаливый дефолт в RUB завысил бы рублёвый итог витрины расходов ровно
    так же, как хардкод "RUB", который эта функция и заменяет."""
    assert currency_from_numeric_code("156") is None  # CNY, пока не в таблице
    assert currency_from_numeric_code("") is None
    assert currency_from_numeric_code(None) is None
    assert currency_from_numeric_code("не число") is None


# ── Разбор списка счетов ──────────────────────────────────────────────────


def test_live_sample_yields_the_account_that_used_to_be_hardcoded():
    """Регресс-якорь миграции: для первого токена API отдаёт ровно тот счёт,
    что был константой в исходнике, — значит поведение первого бизнеса от
    перехода на /bank-accounts не меняется."""
    assert parse_accounts(SAMPLE_ACCOUNTS) == [
        BankAccount("40802810600001780269", "RUB")
    ]


def test_all_returned_accounts_are_taken_not_just_the_first():
    payload = [
        {"accountNumber": "40802810600001780269", "currency": "643"},
        {"accountNumber": "40702810000000000001", "currency": "643"},
    ]
    assert [a.number for a in parse_accounts(payload)] == [
        "40802810600001780269",
        "40702810000000000001",
    ]


def test_account_with_unknown_currency_is_skipped_entirely(capsys):
    """Счёт с неизвестным кодом валюты выпадает целиком и громко: считать его
    рублёвым нельзя, это завысит рублёвый итог. Сегодня все счета студии
    рублёвые, так что путь не срабатывает, но он честный."""
    payload = [
        {"accountNumber": "40802810600001780269", "currency": "643"},
        {"accountNumber": "40806840900001780270", "currency": "156"},
    ]
    accounts = parse_accounts(payload, "TBANK_TOKEN")

    assert accounts == [BankAccount("40802810600001780269", "RUB")]

    logged = capsys.readouterr().out
    assert "40806840900001780270" in logged
    assert "'156'" in logged
    assert "ПРОПУСКАЮ СЧЁТ" in logged


def test_account_without_number_is_skipped():
    payload = [
        {"currency": "643"},
        {"accountNumber": "", "currency": "643"},
        {"accountNumber": "40802810600001780269", "currency": "643"},
    ]
    assert parse_accounts(payload) == [BankAccount("40802810600001780269", "RUB")]


def test_duplicate_account_numbers_collapse():
    """Один счёт не должен отсинкаться дважды и удвоить счётчик строк."""
    payload = [
        {"accountNumber": "40802810600001780269", "currency": "643"},
        {"accountNumber": "40802810600001780269", "currency": "643"},
    ]
    assert parse_accounts(payload) == [BankAccount("40802810600001780269", "RUB")]


def test_non_list_payload_is_reported_and_yields_nothing(capsys):
    """Ответ неожиданной формы — не молчаливый ноль счетов, а видимая в логе
    поломка: иначе бизнес просто перестал бы синкаться без единого следа."""
    assert parse_accounts({"accounts": []}, "TBANK_TOKEN_2") == []
    logged = capsys.readouterr().out
    assert "TBANK_TOKEN_2" in logged
    assert "не список" in logged


def test_garbage_entry_does_not_kill_the_rest():
    payload = ["мусор", {"accountNumber": "40802810600001780269", "currency": "643"}]
    assert parse_accounts(payload) == [BankAccount("40802810600001780269", "RUB")]

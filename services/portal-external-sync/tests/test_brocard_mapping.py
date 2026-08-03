"""Разбор ответов Brocard и раскладка движения баланса по колонкам
brocard_transactions.

Фикстуры — реальные образцы, снятые с живого API 31.07.2026 (см. докстринг
sources/brocard.py): объект state вместо строки, сумма строкой и со знаком,
валюта в нижнем регистре, два разных формата даты у двух эндпоинтов.

Сетевая часть проверяется отдельно, в test_brocard_run.py.
"""
from datetime import datetime, timedelta, timezone

from sources._bank_common import parse_date
from sources.brocard import (
    BrocardCard,
    account_matches_card,
    card_title,
    index_payments,
    linked_payment,
    map_movement,
    owner_card,
    page_items,
    parse_cards,
    parse_datetime,
    parse_state_label,
    to_row,
    BROCARD_COLUMNS,
    DEFAULT_CARD_TITLE,
)

MSK = timezone(timedelta(hours=3))

# ── Фикстуры ──────────────────────────────────────────────────────────────

#: Наша карта. last_four/date живого ответа в постановке не приведены —
#: значение здесь синтетическое, на логику отбора (по названию) оно не влияет.
OUR_CARD_RAW = {
    "id": 2660444,
    "title": "ХОНГ Покупки",
    "last_four": "7788",
    "bin": "450897",
    "currency": "USD",
    # Документация обещает строку, живой API отдаёт объект.
    "state": {"value": 2, "label": "Active"},
    "date": "2025-01-15 12:00:00",
}

FOREIGN_CARD_RAW = {
    "id": 2618593,
    "title": "фб 5",
    "last_four": "5634",
    "bin": "450897",
    "currency": "USD",
    "state": {"value": 2, "label": "Active"},
    "date": "2025-01-15 12:00:00",
}

OUR_CARD = parse_cards([OUR_CARD_RAW], "ХОНГ Покупки")[0]

#: Реальный платёж из постановки — он принадлежит ЧУЖОЙ карте 2618593 и
#: приехал в ответ на запрос с card=2660444. Именно этим доказано, что
#: серверный фильтр по карте не работает.
FOREIGN_PAYMENT = {
    "id": 88122721,
    "initial_amount": "17.00",
    "initial_currency": "USD",
    "amount": "17.00",
    "currency": "USD",
    "merchant": {
        "id": 1,
        "mcc": "7311",
        "name": "Facebook",
        "descriptor": "FACEBK *77VUFV5KE2  650-5434800  US",
        "country": {"id": 2, "code": "US"},
    },
    "state": {"value": 1, "label": "Settled"},
    "is_micro": False,
    "decline": None,
    "user": {"id": 54934, "name": "Nick S", "team": {"id": 40450, "name": "Cash"}},
    "card": {"id": 2618593, "title": "фб 5", "last_four": "5634", "bin": "450897"},
    "fees": [],
    "date": "2026-07-02 01:10:05",
    "date_received": "2026-07-02 01:10:05",
    "date_final_state": "2026-07-02 01:10:05",
}

#: Тот же ответ, но по нашей карте.
OUR_PAYMENT = {
    **FOREIGN_PAYMENT,
    "id": 88122722,
    "card": {
        "id": 2660444,
        "title": "ХОНГ Покупки",
        "last_four": "7788",
        "bin": "450897",
    },
}

#: Отклонённая попытка: платёж деньгами не стал, но комиссия за отказ стала.
DECLINED_PAYMENT = {
    **OUR_PAYMENT,
    "id": 88122723,
    "amount": "0.00",
    "state": {"value": 3, "label": "Declined"},
    "decline": {"id": 7, "reason": "Insufficient funds"},
}

PAYMENTS_BY_ID = index_payments([FOREIGN_PAYMENT, OUR_PAYMENT, DECLINED_PAYMENT])


def _movement(**overrides) -> dict:
    """Движение баланса — форма из живого /api/v2/balance/history."""
    mv = {
        "transaction_id": 501,
        "date": "2026-07-31T09:42:35+03:00",
        "account": "ХОНГ Покупки",
        "account_number": "450897******7788",
        "currency": "usd",
        "amount": "-0.88",
        "balance_before": "100.00",
        "balance_after": "99.12",
        "direction": "outcome",
        "type": "payment_fee",
        "based_on_type": "payment",
        "based_on_id": 88122722,
        "description": "Payment fee",
    }
    mv.update(overrides)
    return mv


# ── state объектом вместо строки ──────────────────────────────────────────


def test_state_object_is_read_by_label():
    """Документация Brocard обещает строку, живой API отдаёт
    {"value": 2, "label": "Active"} — читаем оба вида."""
    assert parse_state_label({"value": 2, "label": "Active"}) == "Active"
    assert parse_state_label("Active") == "Active"
    assert parse_state_label({"value": 2}) == "2"
    assert parse_state_label(None) == ""


def test_card_state_lands_as_label_not_dict():
    assert OUR_CARD.state == "Active"


# ── Отбор карты по названию ───────────────────────────────────────────────


def test_card_is_selected_by_title_not_by_hardcoded_id():
    cards = parse_cards([FOREIGN_CARD_RAW, OUR_CARD_RAW], "ХОНГ Покупки")
    assert [c.id for c in cards] == ["2660444"]


def test_card_title_match_ignores_case_and_spaces():
    cards = parse_cards([{**OUR_CARD_RAW, "title": "  хонг покупки "}], "ХОНГ Покупки")
    assert len(cards) == 1


def test_card_title_match_is_exact_not_substring():
    """«Содержит» подтянуло бы соседнюю карту с похожим названием вместе с
    нужной, и её траты уехали бы в расходы студии."""
    other = {**OUR_CARD_RAW, "id": 1, "title": "ХОНГ Покупки личное"}
    assert parse_cards([other], "ХОНГ Покупки") == []


def test_two_cards_with_the_same_title_are_both_taken():
    """Владелец может перевыпустить карту или завести вторую с тем же
    названием — синк обязан подхватить обе."""
    second = {**OUR_CARD_RAW, "id": 2660445, "last_four": "9900"}
    cards = parse_cards([OUR_CARD_RAW, second], "ХОНГ Покупки")
    assert [c.id for c in cards] == ["2660444", "2660445"]


def test_card_without_id_is_skipped_not_fatal():
    broken = {**OUR_CARD_RAW, "id": None}
    cards = parse_cards([broken, OUR_CARD_RAW], "ХОНГ Покупки")
    assert [c.id for c in cards] == ["2660444"]


def test_card_title_env_defaults_to_the_live_card(monkeypatch):
    assert card_title({}) == DEFAULT_CARD_TITLE == "ХОНГ Покупки"
    assert card_title({"BROCARD_CARD_TITLE": " Другая карта "}) == "Другая карта"
    # Пустое значение переменной = дефолт, а не «все карты аккаунта».
    assert card_title({"BROCARD_CARD_TITLE": "   "}) == DEFAULT_CARD_TITLE


# ── Даты: два формата у двух эндпоинтов ───────────────────────────────────


def test_balance_history_date_keeps_its_offset():
    """/balance/history отдаёт дату со смещением пояса."""
    parsed = parse_datetime("2026-07-31T09:42:35+03:00")
    assert parsed == datetime(2026, 7, 31, 9, 42, 35, tzinfo=MSK)
    assert parsed.utcoffset() == timedelta(hours=3)


def test_payments_date_without_offset_is_read_as_moscow_time():
    """/payments отдаёт дату без смещения — трактуем как московское время."""
    parsed = parse_datetime("2026-07-02 01:10:05")
    assert parsed == datetime(2026, 7, 2, 1, 10, 5, tzinfo=MSK)
    # Тот же момент в UTC — предыдущий день; витрина считает дату по Москве,
    # поэтому операция обязана остаться во 2 июля.
    assert parsed.astimezone(timezone.utc).day == 1


def test_common_parse_date_would_have_shifted_the_day():
    """Почему общий parse_date из _bank_common здесь не используется: он
    режет строку до 19 символов и штампует UTC, то есть смещение
    отбрасывается. Вечерняя операция уезжает на следующий день, потому что
    витрина считает дату как occurred_at AT TIME ZONE 'Europe/Moscow'."""
    evening = "2026-07-31T21:42:35+03:00"

    ours = parse_datetime(evening)
    common = parse_date(evening)

    assert ours.astimezone(MSK).date() == datetime(2026, 7, 31).date()
    assert common.astimezone(MSK).date() == datetime(2026, 8, 1).date()


def test_unparsable_date_returns_none():
    assert parse_datetime("31.07.2026 09:42") is None
    assert parse_datetime("") is None
    assert parse_datetime(None) is None
    assert parse_datetime(1753948955) is None


def test_zulu_suffix_is_understood():
    """Рантайм сегодня 3.11, но нормализуем 'Z' сами, чтобы поведение не
    зависело от версии."""
    assert parse_datetime("2026-07-31T06:42:35Z").utcoffset() == timedelta(0)


# ── Суммы и валюта ────────────────────────────────────────────────────────


def test_negative_string_amount_lands_positive():
    """Главный тест: /balance/history отдаёт расход строкой и со знаком
    ("-0.88"). Витрина складывает amount, поэтому записать это число как есть
    значило бы вычитать траты из расходов."""
    row = map_movement(_movement(), OUR_PAYMENT, OUR_CARD)
    assert row["amount"] == 0.88
    assert row["direction"] == "outcome"


def test_currency_is_uppercased():
    """Курс в fx_rates ищется по 'USD'; с 'usd' рублёвая сумма в витрине
    осталась бы пустой навсегда."""
    row = map_movement(_movement(), OUR_PAYMENT, OUR_CARD)
    assert row["currency"] == "USD"


def test_currency_falls_back_to_the_card_currency():
    row = map_movement(_movement(currency=""), OUR_PAYMENT, OUR_CARD)
    assert row["currency"] == "USD"


def test_currency_missing_everywhere_is_skipped_not_defaulted():
    card_without_currency = OUR_CARD._replace(currency="")
    skip_counts: dict[str, int] = {}
    assert (
        map_movement(_movement(currency=None), OUR_PAYMENT, card_without_currency, skip_counts)
        is None
    )
    assert skip_counts == {"bad_currency": 1}


def test_missing_amount_is_skipped_not_zeroed():
    skip_counts: dict[str, int] = {}
    assert map_movement(_movement(amount=None), OUR_PAYMENT, OUR_CARD, skip_counts) is None
    assert skip_counts == {"bad_amount": 1}


def test_unparsable_date_is_skipped():
    skip_counts: dict[str, int] = {}
    mv = _movement(date="31.07.2026 09:42")
    assert map_movement(mv, OUR_PAYMENT, OUR_CARD, skip_counts) is None
    assert skip_counts == {"bad_date": 1}


def test_movement_without_transaction_id_is_skipped():
    skip_counts: dict[str, int] = {}
    assert map_movement(_movement(transaction_id=None), OUR_PAYMENT, OUR_CARD, skip_counts) is None
    assert skip_counts == {"no_transaction_id": 1}


# ── Типы операций ─────────────────────────────────────────────────────────


def test_payment_void_reduces_expenses_instead_of_becoming_income():
    """Возврат гасит ранее учтённую трату. Витрина складывает amount и не
    знает про направления, поэтому единственный способ «погасить» — лечь
    отрицательным числом. Положительный возврат стал бы второй тратой."""
    mv = _movement(direction="income", type="payment_void", amount="0.88")
    row = map_movement(mv, OUR_PAYMENT, OUR_CARD)
    assert row["amount"] == -0.88
    assert row["direction"] == "income"
    assert row["operation_type"] == "payment_void"


def test_unknown_income_type_is_counted_and_does_not_touch_the_sum():
    """Главный тест: незнакомый приход не вычитается вслепую. Заведи Brocard
    пополнение карты — молчаливое вычитание занизило бы расходы."""
    skip_counts: dict[str, int] = {}
    stats: dict[str, int] = {}
    mv = _movement(direction="income", type="card_topup", amount="500.00")

    assert map_movement(mv, None, OUR_CARD, skip_counts, stats) is None
    assert skip_counts == {"unknown_income_type:card_topup": 1}
    # Строка не создана — в сумму расходов она попасть не может.


def test_unknown_outcome_type_is_kept_as_expense_and_named():
    """Обратная сторона: незнакомый расход — это всё же ушедшие с карты
    деньги, он учитывается, но называется в сводке."""
    stats: dict[str, int] = {}
    skip_counts: dict[str, int] = {}
    mv = _movement(type="card_issue_fee", amount="-5.00")

    row = map_movement(mv, None, OUR_CARD, skip_counts, stats)

    assert row["amount"] == 5.00
    assert skip_counts == {}
    assert stats["unknown_outcome_type:card_issue_fee"] == 1


def test_unknown_direction_is_skipped():
    skip_counts: dict[str, int] = {}
    mv = _movement(direction="hold")
    assert map_movement(mv, OUR_PAYMENT, OUR_CARD, skip_counts) is None
    assert skip_counts == {"unknown_direction:hold": 1}


def test_type_distribution_is_tallied_for_the_summary():
    stats: dict[str, int] = {}
    map_movement(_movement(transaction_id=1, type="payment"), OUR_PAYMENT, OUR_CARD, None, stats)
    map_movement(_movement(transaction_id=2, type="payment_fee"), OUR_PAYMENT, OUR_CARD, None, stats)
    map_movement(_movement(transaction_id=3, type="payment_fee"), OUR_PAYMENT, OUR_CARD, None, stats)
    assert stats["type:payment"] == 1
    assert stats["type:payment_fee"] == 2


# ── Связь комиссии с платежом ─────────────────────────────────────────────


def test_fee_inherits_merchant_from_the_linked_payment():
    """Ради этого и читаются обе ручки: комиссия живёт только в истории
    баланса, мерчант — только в платежах. Без связи 100 комиссий по карте
    легли бы в расходы безымянной кучей вместо разбивки по сервисам."""
    row = map_movement(_movement(), OUR_PAYMENT, OUR_CARD)
    assert row["merchant"] == "Facebook"
    assert row["merchant_category"] == "7311"
    assert row["holder"] == "Nick S"
    assert row["status"] == "Settled"
    assert row["payment_id"] == "88122722"
    assert row["operation_type"] == "payment_fee"


def test_merchant_falls_back_to_the_acquirer_descriptor():
    """`name` заполнен только для мерчантов из справочника Brocard — на живой
    карте это 22 записи из 232. У остальных `id` и `name` пустые, а имя лежит
    в сырой строке эквайера, и без отката к ней разбивка по сервисам пустовала
    бы на девять десятых.

    Образцы — из прода: INSTANTLY SHERIDAN USA, UNIPILE.COM RIORGES FRA.
    """
    payment = {
        **OUR_PAYMENT,
        "merchant": {
            "id": None,
            "mcc": "5734",
            "name": None,
            "descriptor": "UNIPILE.COM RIORGES FRA",
            "country": {"id": 80, "code": "FR"},
        },
    }
    stats: dict[str, int] = {}
    row = map_movement(_movement(), payment, OUR_CARD, None, stats)

    assert row["merchant"] == "UNIPILE.COM RIORGES FRA"
    assert row["merchant_category"] == "5734"
    assert stats.get("no_merchant") is None
    assert stats["merchant_from_descriptor"] == 1


def test_catalog_name_wins_over_the_descriptor():
    """Когда Brocard знает мерчанта, его имя короче и чище сырой строки."""
    stats: dict[str, int] = {}
    row = map_movement(_movement(), OUR_PAYMENT, OUR_CARD, None, stats)

    assert row["merchant"] == "Facebook"
    assert stats["merchant_from_name"] == 1


def test_declined_payment_fee_keeps_the_declined_state():
    """Сам отклонённый платёж деньгами не стал и строки не даёт — движения
    баланса у него нет. Комиссия за отказ стала, учитывается как трата и
    несёт статус породившего её платежа."""
    mv = _movement(type="declined_payment_fee", based_on_id=88122723, amount="-0.50")
    row = map_movement(mv, DECLINED_PAYMENT, OUR_CARD)
    assert row["amount"] == 0.50
    assert row["operation_type"] == "declined_payment_fee"
    assert row["status"] == "Declined"
    assert row["merchant"] == "Facebook"


def test_movement_without_a_payment_has_no_merchant_but_is_still_written():
    stats: dict[str, int] = {}
    row = map_movement(_movement(), None, OUR_CARD, None, stats)
    assert row["merchant"] is None
    assert row["holder"] is None
    assert row["status"] is None
    assert stats["no_merchant"] == 1


def test_linked_payment_is_looked_up_by_based_on_id():
    assert linked_payment(_movement(), PAYMENTS_BY_ID) is OUR_PAYMENT


def test_link_is_not_attempted_for_a_non_payment_basis():
    """Заведи Brocard движение, основанное не на платеже, — его based_on_id
    это id другой сущности, и слепой поиск по индексу платежей мог бы совпасть
    по числу и приписать движению чужого мерчанта."""
    mv = _movement(based_on_type="deposit", based_on_id=88122722)
    assert linked_payment(mv, PAYMENTS_BY_ID) is None


def test_link_is_none_when_payment_is_absent_from_the_index():
    assert linked_payment(_movement(based_on_id=999999), PAYMENTS_BY_ID) is None


# ── Принадлежность карте ──────────────────────────────────────────────────


def test_foreign_card_movement_is_rejected():
    """Главный тест отбора: серверный фильтр card= проверен и не работает —
    в ответ на card=2660444 приехал платёж карты 2618593. Отбор идёт на нашей
    стороне, по карте связанного платежа."""
    mv = _movement(based_on_id=88122721)  # платёж чужой карты
    card, proof = owner_card(mv, FOREIGN_PAYMENT, [OUR_CARD])
    assert card is None
    assert proof == "foreign"


def test_our_card_movement_is_accepted_by_the_payment():
    card, proof = owner_card(_movement(), OUR_PAYMENT, [OUR_CARD])
    assert card == OUR_CARD
    assert proof == "payment"


def test_movement_without_payment_can_be_proven_by_account_fields():
    """Запасной путь: если платёж в индексе не нашёлся (например, /payments
    не отдаёт отклонённые попытки), карту ещё можно опознать по полям самого
    движения."""
    card, proof = owner_card(_movement(), None, [OUR_CARD])
    assert card == OUR_CARD
    assert proof == "account"


def test_unprovable_movement_is_left_unowned():
    """Ни платежа, ни совпадения по account/account_number — доказать нечем.
    Записать такое движение значило бы, возможно, записать чужую трату."""
    mv = _movement(account="Другой счёт", account_number="450897******0001")
    card, proof = owner_card(mv, None, [OUR_CARD])
    assert card is None
    assert proof == "unknown"


def test_account_match_reads_title_id_and_last_four():
    assert account_matches_card({"account": "ХОНГ Покупки"}, OUR_CARD)
    assert account_matches_card({"account_number": "2660444"}, OUR_CARD)
    assert account_matches_card({"account_number": "450897******7788"}, OUR_CARD)
    assert not account_matches_card({"account_number": "450897******5634"}, OUR_CARD)
    assert not account_matches_card({}, OUR_CARD)


# ── Раскладка по колонкам ─────────────────────────────────────────────────


def test_row_matches_column_order():
    row = map_movement(_movement(), OUR_PAYMENT, OUR_CARD)
    values = to_row(row)
    assert len(values) == len(BROCARD_COLUMNS) == 16
    assert values[BROCARD_COLUMNS.index("external_id")] == "501"
    assert values[BROCARD_COLUMNS.index("card_id")] == "2660444"
    assert values[BROCARD_COLUMNS.index("card_label")] == "ХОНГ Покупки"
    assert values[BROCARD_COLUMNS.index("amount")] == 0.88
    assert values[BROCARD_COLUMNS.index("currency")] == "USD"


def test_account_columns_are_left_empty_on_purpose():
    """Движение по балансу и есть списание со счёта — дублировать ту же сумму
    во вторую пару колонок нечем. Исходная сумма покупки в валюте мерчанта
    остаётся в raw."""
    row = map_movement(_movement(), OUR_PAYMENT, OUR_CARD)
    assert row["amount_account"] is None
    assert row["currency_account"] is None
    assert '"initial_amount": "17.00"' in row["raw"]


def test_raw_keeps_both_sides_of_the_link():
    row = map_movement(_movement(), OUR_PAYMENT, OUR_CARD)
    assert '"movement"' in row["raw"] and '"payment"' in row["raw"]
    # ensure_ascii=False — кириллица в raw читаемая, как у банковских источников.
    assert "ХОНГ Покупки" in row["raw"]


# ── Пагинация ─────────────────────────────────────────────────────────────


def test_page_items_reads_data_and_last_page():
    payload = {
        "data": [{"id": 1}, {"id": 2}],
        "total": 232,
        "per_page": 100,
        "current_page": 1,
        "last_page": 3,
    }
    items, last_page = page_items(payload)
    assert [i["id"] for i in items] == [1, 2]
    assert last_page == 3


def test_page_items_without_last_page_says_so():
    """None вместо last_page — сигнал вызывающему идти по признаку «страница
    пришла полной». Подставить 1 значило бы молча обрезать выгрузку."""
    items, last_page = page_items({"data": [{"id": 1}]})
    assert last_page is None


def test_page_items_tolerates_a_bare_list():
    items, last_page = page_items([{"id": 1}, "мусор"])
    assert [i["id"] for i in items] == [1]
    assert last_page == 1


def test_page_items_of_garbage_is_empty():
    assert page_items("не ответ") == ([], 1)

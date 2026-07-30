"""Маппинг банковских операций (Точка, Т-Банк) в строку bank_transactions.

Логика вынесена в чистые функции map_transaction/map_operation именно ради
этих тестов: сетевые части (_fetch_period у Точки, run у Т-Банка) ходят в
сеть и в юните непроверяемы.
"""
from sources.bank_tbank import map_operation
from sources.bank_tochka import map_transaction

CREDIT = {
    "creditDebitIndicator": "Credit",
    "transactionId": "tx-credit-1",
    "documentNumber": "101",
    "documentProcessDate": "2026-07-15",
    "Amount": {"amount": "5000.00", "amountNat": "5000.00", "currency": "RUB"},
    "DebtorParty": {"name": "ООО Клиент", "inn": "7701234567"},
    "CreditorParty": {"name": "ИП Мы", "inn": "165808519703"},
    "CreditorAccount": "40802810600001780269",
    "description": "Оплата по счёту 42",
    "paymentId": "pay-101",
    "status": "Executed",
    "transactionTypeCode": "01",
}

# Живая проверка API Точки 30.07.2026: у расходной операции DebtorParty
# отсутствует вовсе — мы сами плательщик, банк его не присылает (не пустой
# объект, а отсутствующий ключ). Amount приходит объектом с
# amount/amountNat/currency, а не голым числом. documentProcessDate — дата
# без времени и без смещения пояса. paymentId/status/transactionTypeCode/
# CreditorAccount — реальные ключи ответа, тоже подтверждённые тем прогоном.
DEBIT = {
    "creditDebitIndicator": "Debit",
    "transactionId": "tx-debit-1",
    "documentNumber": "202",
    "documentProcessDate": "2026-07-16",
    "Amount": {"amount": "1500.50", "amountNat": "1500.50", "currency": "RUB"},
    "CreditorParty": {"name": "ООО ЯНДЕКС", "inn": "7736207543"},
    "CreditorAccount": "40702810900000012345",
    "description": "Оплата рекламных услуг",
    "paymentId": "pay-202",
    "status": "Executed",
    "transactionTypeCode": "01",
}


def test_credit_keeps_payer_and_revenue_flag():
    row = map_transaction(CREDIT, "acc-1")
    assert row["direction"] == "credit"
    assert row["payer_name"] == "ООО Клиент"
    assert row["payer_inn"] == "7701234567"
    assert row["payee_name"] is None
    assert row["is_revenue"] is True
    assert row["exclude_reason"] is None


def test_debit_fills_payee_and_leaves_revenue_unset():
    row = map_transaction(DEBIT, "acc-1")
    assert row["direction"] == "debit"
    assert row["payee_name"] == "ООО ЯНДЕКС"
    assert row["payee_inn"] == "7736207543"
    assert row["payer_name"] is None
    # Классификатор выручки к расходу неприменим: пустой is_revenue честнее,
    # чем False, который читался бы как «проверили и это не выручка».
    assert row["is_revenue"] is None
    assert row["exclude_reason"] is None


def test_unknown_indicator_is_skipped():
    assert map_transaction({"creditDebitIndicator": "Reserved"}, "acc-1") is None


def test_transaction_id_falls_back_to_document_number():
    tx = dict(DEBIT)
    del tx["transactionId"]
    row = map_transaction(tx, "acc-9")
    assert row["transaction_id"] == "acc-9|202"


def test_unparsable_date_is_skipped():
    """Перед бэкфиллом за 2023 год: битая дата не должна ронять весь батч,
    она просто пропускается."""
    tx = dict(DEBIT)
    tx["documentProcessDate"] = "15.07.2026"  # неожиданный формат
    assert map_transaction(tx, "acc-1") is None


def test_missing_amount_is_skipped_not_zeroed():
    """Главный тест: отсутствующая сумма не должна тихо стать 0.00 —
    настоящий ноль в выписке и отсутствующая сумма это разные вещи."""
    tx = dict(DEBIT)
    del tx["Amount"]
    assert map_transaction(tx, "acc-1") is None


def test_debit_without_creditor_party_is_not_dropped():
    """Уже существующее поведение, зафиксированное намеренно: расход без
    получателя не отбрасывается целиком, он просто уходит в очередь ручной
    разметки с пустыми payee_name/payee_inn."""
    tx = dict(DEBIT)
    del tx["CreditorParty"]
    row = map_transaction(tx, "acc-1")
    assert row is not None
    assert row["payee_name"] is None
    assert row["payee_inn"] is None


def test_currency_defaults_to_rub_from_fixtures():
    """Фикстуры сами по себе рублёвые — currency читается из Amount, а не
    хардкодится, поэтому дефолтный прогон должен остаться RUB."""
    assert map_transaction(CREDIT, "acc-1")["currency"] == "RUB"
    assert map_transaction(DEBIT, "acc-1")["currency"] == "RUB"


def test_currency_is_read_from_amount_and_uppercased():
    """Главный тест: если платёж придёт не в рублях, он не должен молча
    лечь рублёвым — валюта берётся из Amount.currency, а не константой."""
    tx = dict(DEBIT)
    tx["Amount"] = {"amount": "1500.50", "amountNat": "1500.50", "currency": "usd"}
    row = map_transaction(tx, "acc-1")
    assert row["currency"] == "USD"


def test_currency_falls_back_to_rub_when_field_missing():
    tx = dict(DEBIT)
    tx["Amount"] = {"amount": "1500.50", "amountNat": "1500.50"}  # без currency
    row = map_transaction(tx, "acc-1")
    assert row["currency"] == "RUB"


def test_currency_falls_back_to_rub_when_field_empty():
    tx = dict(DEBIT)
    tx["Amount"] = {"amount": "1500.50", "currency": ""}
    row = map_transaction(tx, "acc-1")
    assert row["currency"] == "RUB"


def test_amount_nat_is_read_alongside_amount():
    """amount_nat нужен только сверке остатков (reconcile_period_totals),
    в bank_transactions не пишется, но map_transaction обязан класть его в
    возвращаемый словарь, читая Amount.amountNat отдельно от Amount.amount —
    на валютной операции они разные числа."""
    tx = dict(DEBIT)
    tx["Amount"] = {"amount": "55.00", "amountNat": "5000.00", "currency": "usd"}
    row = map_transaction(tx, "acc-1")
    assert row["amount"] == 55.00
    assert row["amount_nat"] == 5000.00


def test_amount_nat_is_none_when_field_missing():
    """Amount без amountNat — не ошибка, реконсиляция сама падёт обратно на
    amount (см. test_bank_tochka_reconcile.py)."""
    tx = dict(DEBIT)
    tx["Amount"] = {"amount": "1500.50", "currency": "RUB"}  # без amountNat
    row = map_transaction(tx, "acc-1")
    assert row["amount_nat"] is None


def test_status_counts_tally_by_value():
    """status_counts, общий на весь прогон, обязан копить встреченные
    значения Transaction.status по отдельности — их печатает в сводке в
    конце run(). Мы не знаем полный набор возможных значений заранее, так
    что просто считаем встреченное как есть, ничего не отбрасывая."""
    status_counts: dict[str, int] = {}

    executed = dict(CREDIT)
    executed["status"] = "Executed"
    pending = dict(DEBIT)
    pending["status"] = "Pending"
    another_executed = dict(DEBIT)
    another_executed["status"] = "Executed"

    map_transaction(executed, "acc-1", status_counts=status_counts)
    map_transaction(pending, "acc-1", status_counts=status_counts)
    map_transaction(another_executed, "acc-1", status_counts=status_counts)

    assert status_counts == {"Executed": 2, "Pending": 1}


def test_status_counts_uses_missing_marker_when_field_absent():
    status_counts: dict[str, int] = {}
    tx = dict(CREDIT)
    del tx["status"]
    map_transaction(tx, "acc-1", status_counts=status_counts)
    assert status_counts == {"<missing>": 1}


def test_status_counts_counts_even_skipped_records():
    """Статус считается для каждой встреченной операции, даже той, что
    дальше будет отброшена по другой причине (тут — неизвестный индикатор) —
    цель увидеть весь спектр значений status, а не только те, что доехали
    до записи в базу."""
    status_counts: dict[str, int] = {}
    unknown = {"creditDebitIndicator": "Reserved", "status": "Cancelled"}
    assert map_transaction(unknown, "acc-1", status_counts=status_counts) is None
    assert status_counts == {"Cancelled": 1}


ACC = "40802810600001780269"

TB_CREDIT = {
    "operationId": "op-1",
    "id": 11,
    "date": "2026-07-15",
    "amount": 5000,
    "recipientAccount": ACC,
    "payerName": "ООО Клиент",
    "payerInn": "7701234567",
    "paymentPurpose": "Оплата по счёту 42",
}

TB_DEBIT = {
    "operationId": "op-2",
    "id": 12,
    "date": "2026-07-16",
    "amount": 1500.5,
    "recipientAccount": "40702810000000000001",
    "payerAccount": ACC,
    # Реальный ответ API отдаёт имя получателя в "recipient", а не
    # "recipientName" — так и должна выглядеть фикстура (см.
    # test_tbank_debit_payee_name_reads_recipient_field).
    "recipient": "ООО ЯНДЕКС",
    "recipientInn": "7736207543",
    "paymentPurpose": "Оплата рекламных услуг",
}


def test_tbank_credit_marks_revenue():
    row = map_operation(TB_CREDIT, ACC)
    assert row["direction"] == "credit"
    assert row["payer_name"] == "ООО Клиент"
    assert row["is_revenue"] is True


def test_tbank_debit_fills_payee():
    row = map_operation(TB_DEBIT, ACC)
    assert row["direction"] == "debit"
    assert row["payee_name"] == "ООО ЯНДЕКС"
    assert row["payee_inn"] == "7736207543"
    assert row["is_revenue"] is None


def test_tbank_debit_payee_name_reads_recipient_field():
    """Живая проверка API Т-Банка 30.07.2026 показала: имя получателя в
    ответе приходит в поле "recipient", а не "recipientName" (такого поля
    в ответе не существует). map_operation читал именно "recipientName",
    поэтому payee_name у всех расходных операций уходил в базу пустым, и
    правила разметки по имени получателя не срабатывали вовсе. Тест
    зафиксирован отдельно от test_tbank_debit_fills_payee — тот тоже ловит
    регресс, но не объясняет, из какого именно поля должно браться имя."""
    row = map_operation(TB_DEBIT, ACC)
    assert row["payee_name"] == TB_DEBIT["recipient"]


def test_tbank_foreign_operation_is_skipped():
    """Операция, где наш счёт не участвует ни одной стороной."""
    assert map_operation({"recipientAccount": "1", "payerAccount": "2"}, ACC) is None


def test_tbank_unparsable_date_is_skipped():
    """Перед бэкфиллом за 2023 год: битая дата не должна ронять весь батч,
    она просто пропускается."""
    tx = dict(TB_DEBIT)
    tx["date"] = "16.07.2026"  # неожиданный формат
    assert map_operation(tx, ACC) is None


def test_tbank_missing_amount_is_skipped_not_zeroed():
    """Главный тест: отсутствующая сумма не должна тихо стать 0.00 —
    настоящий ноль в выписке и отсутствующая сумма это разные вещи."""
    tx = dict(TB_DEBIT)
    del tx["amount"]
    assert map_operation(tx, ACC) is None


def test_tbank_skip_counts_tally_by_reason():
    """skip_counts, общий на весь прогон, обязан копить причины пропуска
    по отдельности — это то, что печатается в сводке в конце run(). Без
    счётчика на "чужие" операции опечатка в имени поля API (например, если
    ответ вдруг придёт не с payerAccount) тихо превратила бы весь расход в
    "за период не было операций", неотличимое от правды."""
    skip_counts: dict[str, int] = {}

    bad_date = dict(TB_DEBIT)
    bad_date["date"] = "16.07.2026"
    bad_amount = dict(TB_DEBIT)
    del bad_amount["amount"]
    foreign = {"recipientAccount": "1", "payerAccount": "2"}

    assert map_operation(bad_date, ACC, skip_counts) is None
    assert map_operation(bad_amount, ACC, skip_counts) is None
    assert map_operation(foreign, ACC, skip_counts) is None
    assert map_operation(foreign, ACC, skip_counts) is None  # ещё одна чужая

    assert skip_counts == {"bad_date": 1, "bad_amount": 1, "not_ours": 2}

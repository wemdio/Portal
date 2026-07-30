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
    "Amount": {"amount": "5000.00"},
    "DebtorParty": {"name": "ООО Клиент", "inn": "7701234567"},
    "CreditorParty": {"name": "ИП Мы", "inn": "165808519703"},
    "description": "Оплата по счёту 42",
}

DEBIT = {
    "creditDebitIndicator": "Debit",
    "transactionId": "tx-debit-1",
    "documentNumber": "202",
    "documentProcessDate": "2026-07-16",
    "Amount": {"amount": "1500.50"},
    "DebtorParty": {"name": "ИП Мы", "inn": "165808519703"},
    "CreditorParty": {"name": "ООО ЯНДЕКС", "inn": "7736207543"},
    "description": "Оплата рекламных услуг",
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


ACC = "40802810600001780269"

TB_CREDIT = {
    "operationId": "op-1",
    "id": 11,
    "date": "2026-07-15T10:00:00",
    "amount": 5000,
    "recipientAccount": ACC,
    "payerName": "ООО Клиент",
    "payerInn": "7701234567",
    "paymentPurpose": "Оплата по счёту 42",
}

TB_DEBIT = {
    "operationId": "op-2",
    "id": 12,
    "date": "2026-07-16T10:00:00",
    "amount": 1500.5,
    "recipientAccount": "40702810000000000001",
    "payerAccount": ACC,
    "recipientName": "ООО ЯНДЕКС",
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

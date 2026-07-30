"""Маппинг операций Точки в строку bank_transactions.

Логика вынесена в чистую функцию map_transaction именно ради этих тестов:
сам _fetch_period ходит в сеть и в юните непроверяем.
"""
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

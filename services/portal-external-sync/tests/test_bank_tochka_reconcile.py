"""Сверка итогов Точки (reconcile_period_totals, sources/bank_tochka.py).

Ответ Statement содержит startDateBalance/endDateBalance — остатки на начало
и конец периода. Пагинации в ответе Точки нет, поэтому тождество
endDateBalance - startDateBalance == сумма приходов - сумма расходов —
единственная доступная проверка того, что мы загрузили ровно то, что было
в выписке, а не часть операций (сетевой сбой, битая дата/сумма и т.п.).

Функция чистая: список уже замапленных строк (map_transaction, до to_row) +
сырой объект Statement за период → список строк-предупреждений. Юнит-
тестируема без сети и без БД — по образцу sources/bank_tbank.py
reconcile_period_totals / tests/test_bank_tbank_reconcile.py, чтобы оба
источника были устроены одинаково.
"""
from sources.bank_tochka import reconcile_period_totals

CREDIT_ROW = {"direction": "credit", "amount": 5000.0}
DEBIT_ROW = {"direction": "debit", "amount": 606.42}
DEBIT_ROW_2 = {"direction": "debit", "amount": 490.0}


def test_matching_totals_produce_no_warnings():
    rows = [CREDIT_ROW, DEBIT_ROW, DEBIT_ROW_2]
    # bank_delta = 4903.58 - 1000.0 = 3903.58 = 5000 - 606.42 - 490 = mapped_delta
    statement = {"startDateBalance": 1000.0, "endDateBalance": 4903.58}
    assert reconcile_period_totals(rows, statement) == []


def test_balance_mismatch_is_reported_with_both_numbers_and_diff():
    """Расход недосчитан на одну операцию (490) — ровно тот сценарий, из-за
    которого раньше подозревали пагинацию."""
    rows = [CREDIT_ROW, DEBIT_ROW]  # DEBIT_ROW_2 "потерялась"
    statement = {"startDateBalance": 1000.0, "endDateBalance": 4903.58}
    warnings = reconcile_period_totals(rows, statement)
    assert len(warnings) == 1
    assert "balance mismatch" in warnings[0]
    assert "bank_delta=3903.58" in warnings[0]
    assert "mapped_delta=4393.58" in warnings[0]
    assert "diff=-490.00" in warnings[0]


def test_missing_balance_fields_is_silently_skipped():
    """Отсутствие startDateBalance/endDateBalance в ответе — не ошибка, а
    повод молча пропустить сверку."""
    rows = [CREDIT_ROW, DEBIT_ROW]
    assert reconcile_period_totals(rows, {}) == []


def test_partial_balance_fields_is_silently_skipped():
    """Пришёл только один из двух остатков — сверка невозможна, но это
    не повод падать или предупреждать: молча пропускаем."""
    rows = [CREDIT_ROW, DEBIT_ROW]
    assert reconcile_period_totals(rows, {"startDateBalance": 1000.0}) == []


def test_tolerance_absorbs_kopeck_rounding():
    """Сравнение — с допуском на копейки, не точное равенство float."""
    rows = [DEBIT_ROW]
    statement = {"startDateBalance": 1000.0, "endDateBalance": 1000.0 - 606.42 + 0.005}
    assert reconcile_period_totals(rows, statement) == []


def test_beyond_tolerance_is_still_reported():
    rows = [DEBIT_ROW]
    statement = {"startDateBalance": 1000.0, "endDateBalance": 1000.0 - 606.42 + 0.02}
    warnings = reconcile_period_totals(rows, statement)
    assert len(warnings) == 1
    assert "balance mismatch" in warnings[0]


def test_nested_balance_objects_are_handled():
    """Остатки могут прийти вложенным объектом вида Amount ({"amount": ...}),
    а не голым числом — живого примера структуры не было, только имена
    ключей, так что оба варианта обязаны обрабатываться устойчиво."""
    rows = [CREDIT_ROW]  # 5000 прихода, расхода нет
    statement = {
        "startDateBalance": {"amount": "1000.00", "currency": "RUB"},
        "endDateBalance": {"amount": "6000.00", "currency": "RUB"},
    }
    assert reconcile_period_totals(rows, statement) == []


def test_nested_balance_objects_still_catch_mismatch():
    rows = [CREDIT_ROW]  # 5000 прихода
    statement = {
        "startDateBalance": {"amount": "1000.00"},
        "endDateBalance": {"amount": "5500.00"},  # должно быть 6000
    }
    warnings = reconcile_period_totals(rows, statement)
    assert len(warnings) == 1
    assert "balance mismatch" in warnings[0]

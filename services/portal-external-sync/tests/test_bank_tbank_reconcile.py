"""Сверка итогов Т-Банка (reconcile_period_totals, sources/bank_tbank.py).

Ответ /bank-statement содержит income/outcome — суммы прихода и расхода за
период, посчитанные самим банком. Это единственная доступная проверка
полноты выгрузки: у ручки нет ни курсора, ни total, поэтому расхождение с
этими двумя числами — единственный сигнал, что часть операций до базы не
доехала (то, что раньше пытались объяснить подозрением на пагинацию).

Функция чистая: список уже замапленных строк (map_operation, до to_row) +
сырой ответ банка → список строк-предупреждений. Юнит-тестируема без сети и
без БД.
"""
from sources.bank_tbank import reconcile_period_totals

CREDIT_ROW = {"direction": "credit", "amount": 5000.0}
DEBIT_ROW = {"direction": "debit", "amount": 606.42}
DEBIT_ROW_2 = {"direction": "debit", "amount": 490.0}


def test_matching_totals_produce_no_warnings():
    rows = [CREDIT_ROW, DEBIT_ROW, DEBIT_ROW_2]
    data = {"income": 5000.0, "outcome": 1096.42}
    assert reconcile_period_totals(rows, data) == []


def test_outcome_mismatch_is_reported_with_both_numbers_and_diff():
    """Расход недосчитан на одну операцию (490) — ровно тот сценарий, из-за
    которого раньше подозревали пагинацию."""
    rows = [CREDIT_ROW, DEBIT_ROW]  # DEBIT_ROW_2 "потерялась"
    data = {"income": 5000.0, "outcome": 1096.42}
    warnings = reconcile_period_totals(rows, data)
    assert len(warnings) == 1
    assert "outcome mismatch" in warnings[0]
    assert "bank=1096.42" in warnings[0]
    assert "mapped=606.42" in warnings[0]
    assert "-490.00" in warnings[0]


def test_income_mismatch_is_reported_independently_of_outcome():
    rows = [DEBIT_ROW]  # весь приход "потерялся"
    data = {"income": 5000.0, "outcome": 606.42}
    warnings = reconcile_period_totals(rows, data)
    assert len(warnings) == 1
    assert "income mismatch" in warnings[0]
    assert "bank=5000.0" in warnings[0]
    assert "mapped=0" in warnings[0]


def test_missing_income_and_outcome_is_silently_skipped():
    """Отсутствие income/outcome в ответе — не ошибка, а повод молча
    пропустить сверку по этому полю."""
    rows = [CREDIT_ROW, DEBIT_ROW]
    assert reconcile_period_totals(rows, {}) == []


def test_tolerance_absorbs_kopeck_rounding():
    """Сравнение — с допуском на копейки, не точное равенство float."""
    rows = [DEBIT_ROW]
    data = {"outcome": 606.42 + 0.005}
    assert reconcile_period_totals(rows, data) == []


def test_beyond_tolerance_is_still_reported():
    rows = [DEBIT_ROW]
    data = {"outcome": 606.42 + 0.02}
    warnings = reconcile_period_totals(rows, data)
    assert len(warnings) == 1
    assert "outcome mismatch" in warnings[0]

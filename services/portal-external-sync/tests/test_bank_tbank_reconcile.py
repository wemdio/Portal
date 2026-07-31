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


# ── Сверка в границах одного счёта ────────────────────────────────────────
#
# income/outcome банк считает по одному конкретному счёту, а счетов у токена
# может быть несколько. Если свалить операции разных счетов в общий котёл,
# сверка сравнит их сумму с итогом одного счёта и начнёт врать в обе стороны:
# лишние операции чужого счёта дадут «расхождение» там, где всё сошлось, а
# недостача своего счёта замаскируется чужим приходом. Проверка обязана
# оставаться в границах «токен + счёт + период».

ACC_A = "40802810600001780269"
ACC_B = "40702810000000000001"

A_CREDIT = {"direction": "credit", "amount": 5000.0, "account_id": ACC_A}
A_DEBIT = {"direction": "debit", "amount": 606.42, "account_id": ACC_A}
B_CREDIT = {"direction": "credit", "amount": 999999.0, "account_id": ACC_B}
B_DEBIT = {"direction": "debit", "amount": 777777.0, "account_id": ACC_B}


def test_totals_of_another_account_do_not_leak_into_the_check():
    """Главный тест: строки чужого счёта в списке не должны влиять на сверку
    нашего — итоги банка относятся только к нашему."""
    rows = [A_CREDIT, A_DEBIT, B_CREDIT, B_DEBIT]
    data = {"income": 5000.0, "outcome": 606.42}  # итоги счёта A
    assert reconcile_period_totals(rows, data, account=ACC_A) == []


def test_own_shortfall_is_not_masked_by_another_accounts_rows():
    """Обратная сторона: недостача своего счёта обязана быть видна, даже
    когда рядом лежат операции другого счёта на любые суммы."""
    rows = [A_DEBIT, B_CREDIT]  # приход счёта A "потерялся"
    data = {"income": 5000.0, "outcome": 606.42}
    warnings = reconcile_period_totals(rows, data, account=ACC_A)
    assert len(warnings) == 1
    assert "income mismatch" in warnings[0]
    assert "mapped=0" in warnings[0]


def test_mismatch_message_names_the_account():
    """В сообщении о расхождении должен быть виден счёт — иначе с несколькими
    счетами в логе не понять, чей период не сошёлся."""
    rows = [A_DEBIT]
    data = {"outcome": 606.42 + 1}
    warnings = reconcile_period_totals(rows, data, account=ACC_A)
    assert len(warnings) == 1
    assert f"acc={ACC_A}" in warnings[0]


def test_without_account_behaviour_is_unchanged():
    """Без явного счёта фильтра нет и номер в сообщение не подставляется —
    старые вызовы работают как работали."""
    rows = [A_CREDIT, A_DEBIT]
    data = {"income": 5000.0, "outcome": 606.42}
    assert reconcile_period_totals(rows, data) == []
    assert "acc=" not in "".join(
        reconcile_period_totals(rows, {"outcome": 0.0})
    )

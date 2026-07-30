"""Общий разбор суммы для обоих банков (см. sources/_bank_common.py).

coerce_amount — единственная точка контроля, где значение из API банка
становится float либо None. nan/inf отдельно проверяются здесь: обе banки
формально проходят float(), не бросают исключение и не равны None, поэтому
без math.isfinite() тихо попали бы в базу как валидная сумма и отравили бы
sum(amount) по всей витрине расходов.
"""
import math

from sources._bank_common import coerce_amount


def test_none_is_missing():
    assert coerce_amount(None) is None


def test_non_numeric_string_is_missing():
    assert coerce_amount("не число") is None


def test_real_zero_is_a_valid_amount():
    """Настоящий ноль в выписке — валидная сумма, а не повод для пропуска."""
    assert coerce_amount("0") == 0.0
    assert coerce_amount(0) == 0.0


def test_negative_amount_is_valid():
    assert coerce_amount("-1500.50") == -1500.50


def test_nan_is_rejected():
    assert coerce_amount(float("nan")) is None
    assert coerce_amount("nan") is None


def test_infinity_is_rejected():
    assert coerce_amount(float("inf")) is None
    assert coerce_amount("Infinity") is None


def test_ordinary_value_stays_finite_float():
    result = coerce_amount("5000.00")
    assert result == 5000.00
    assert math.isfinite(result)

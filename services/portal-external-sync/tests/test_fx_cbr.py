"""Парсер XML ЦБ.

Два подвоха, ради которых тест и существует:
  - Value приходит с запятой как десятичным разделителем;
  - Nominal у части валют не 1 (у юаня 10), и без деления курс завышен в 10 раз.

Плюс два реальных случая из ответа ЦБ, которые стоит не уронить молча:
валюта без CharCode (бывает при перегенерации справочника на их стороне) и
валюта без Value (технический сбой на стороне ЦБ) — обе должны быть просто
пропущены, а не попасть в rates как половинчатая запись.
"""
from datetime import date
from decimal import Decimal

from sources.fx_cbr import parse_cbr_xml

SAMPLE = """<?xml version="1.0" encoding="windows-1251"?>
<ValCurs Date="30.07.2026" name="Foreign Currency Market">
<Valute ID="R01235"><NumCode>840</NumCode><CharCode>USD</CharCode><Nominal>1</Nominal><Name>Доллар США</Name><Value>78,4512</Value></Valute>
<Valute ID="R01239"><NumCode>978</NumCode><CharCode>EUR</CharCode><Nominal>1</Nominal><Name>Евро</Name><Value>91,2033</Value></Valute>
<Valute ID="R01375"><NumCode>156</NumCode><CharCode>CNY</CharCode><Nominal>10</Nominal><Name>Китайских юаней</Name><Value>108,5000</Value></Valute>
</ValCurs>"""

MISSING_FIELDS = """<?xml version="1.0" encoding="windows-1251"?>
<ValCurs Date="30.07.2026" name="Foreign Currency Market">
<Valute ID="R01235"><NumCode>840</NumCode><CharCode>USD</CharCode><Nominal>1</Nominal><Name>Доллар США</Name><Value>78,4512</Value></Valute>
<Valute ID="R01999"><NumCode>999</NumCode><Nominal>1</Nominal><Name>Без кода валюты</Name><Value>1,0000</Value></Valute>
<Valute ID="R01998"><NumCode>998</NumCode><CharCode>ZZZ</CharCode><Nominal>1</Nominal><Name>Без значения курса</Name></Valute>
</ValCurs>"""


def test_reads_published_date_not_requested_one():
    published_on, _ = parse_cbr_xml(SAMPLE)
    assert published_on == date(2026, 7, 30)


def test_comma_decimal_separator():
    _, rates = parse_cbr_xml(SAMPLE)
    assert rates["USD"] == Decimal("78.4512")


def test_divides_by_nominal():
    _, rates = parse_cbr_xml(SAMPLE)
    assert rates["CNY"] == Decimal("10.85")


def test_valute_without_charcode_is_skipped():
    """Реальный случай ответа ЦБ: запись без CharCode нельзя положить в
    fx_rates — там нет ключа, под каким её искать в expenses_v."""
    _, rates = parse_cbr_xml(MISSING_FIELDS)
    assert "USD" in rates
    assert len(rates) == 1


def test_valute_without_value_is_skipped():
    """ZZZ в MISSING_FIELDS не имеет тега Value вовсе — пропускаем, а не
    падаем на Decimal('')."""
    _, rates = parse_cbr_xml(MISSING_FIELDS)
    assert "ZZZ" not in rates

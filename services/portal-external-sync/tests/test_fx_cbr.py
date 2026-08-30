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

from sources.fx_cbr import _NEEDED_DATES_SQL, parse_cbr_xml

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


# ─── Отбор дат ─────────────────────────────────────────────────────────────
#
# Предикат живёт в SQL и без базы не исполняется, поэтому тесты ниже стерегут
# его форму, а не результат. Ценность не в сверке строк как таковой: оба
# условия уже один раз ломали деньги в отчётах, а вернуть окно обратно —
# правка на одну строку, которую иначе нечем поймать. Смысл каждого условия
# разобран в комментариях у самого SQL.


def test_dates_are_selected_by_exact_match_not_by_window():
    """Окно «есть курс не старше N дней» закрывало обычные будни: 13.08 не
    запрашивался из-за курса за 12.08, и приход дня считался по позавчерашнему
    курсу. Отбор идёт по точному совпадению даты."""
    assert "f.rate_date = x.d" in _NEEDED_DATES_SQL
    assert "interval '10 days'" not in _NEEDED_DATES_SQL


def test_probes_break_the_weekend_loop():
    """Точное совпадение само по себе зациклилось бы: за субботу ЦБ отдаёт
    пятничный курс под пятничной датой, строки с rate_date = суббота не будет
    никогда. Цикл разрывает память о запросе."""
    assert "fx_rate_probes" in _NEEDED_DATES_SQL


def test_future_dates_are_not_requested():
    """Курса за завтра у ЦБ ещё нет, а запрос пометил бы дату отработанной."""
    assert "x.d <= current_date" in _NEEDED_DATES_SQL

"""
Unit coverage for the discovery (People-search + LLM-qualify) pure helpers
(2026-06-12). The DOM search (li_actions.search_people), LLM calls, and DB glue
(_discover_batch) need a live LinkedIn session — covered by dogfood.
"""
from linkedin.portal_daemon.handlers import _parse_keywords, _parse_qualify_verdict


# ─────────────── _parse_keywords ───────────────


def test_keywords_strip_numbering_and_bullets():
    text = '1. CTO fintech\n2) Head of Engineering\n- VP Product\n* Технический директор'
    assert _parse_keywords(text, 6) == [
        'CTO fintech', 'Head of Engineering', 'VP Product', 'Технический директор',
    ]


def test_keywords_dedup_case_insensitive_and_limit():
    assert _parse_keywords('CTO\ncto\nHead\nVP\nVP\nLead\n', 3) == ['CTO', 'Head', 'VP']


def test_keywords_skip_empty_and_overlong():
    text = 'ok\n\n' + ('x' * 90) + '\nfine'
    assert _parse_keywords(text, 6) == ['ok', 'fine']


def test_keywords_strip_quotes():
    assert _parse_keywords('"CTO fintech"\n', 6) == ['CTO fintech']


def test_keywords_keeps_leading_digit_word():
    # Targeted marker strip must NOT eat a real keyword starting with a digit.
    assert _parse_keywords('3D designer\n', 6) == ['3D designer']


# ─────────────── _parse_qualify_verdict ───────────────


def test_verdict_yes():
    ok, reason = _parse_qualify_verdict('YES\nCTO в целевой отрасли')
    assert ok is True
    assert reason == 'CTO в целевой отрасли'


def test_verdict_no():
    ok, reason = _parse_qualify_verdict('NO\nНе ЛПР, студент')
    assert ok is False
    assert reason == 'Не ЛПР, студент'


def test_verdict_da_russian():
    ok, _ = _parse_qualify_verdict('ДА, релевантен')
    assert ok is True


def test_verdict_empty_is_not_qualified():
    ok, reason = _parse_qualify_verdict('')
    assert ok is False
    assert 'empty' in reason


def test_verdict_single_line_reason_fallback():
    ok, reason = _parse_qualify_verdict('YES')
    assert ok is True
    assert reason == 'YES'

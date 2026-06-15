"""
Unit coverage for the LinkedIn Outreach 2.0 blocker fixes (2026-06-12):

  #1 li2_campaigns.working_hours — Postgres text[] must map to ArrayField,
     not JSONField (JSONField crashed on every Campaign read).
  #3 daemon prompt rendering — Jinja2, missing vars → empty string (never a
     leaked `{{ placeholder }}` in a message to a lead).
  #4 proxy_url parsing — into a Playwright proxy dict; the broken prod value
     `socks5://ip:port:user:pass` must raise, never silently launch sans proxy.

Pure-function tests — no LinkedIn / browser / network. They import li2.models
and portal_daemon modules, so Django must be configured (pytest-django reads
DJANGO_SETTINGS_MODULE from pytest.ini).
"""
import pytest
from django.contrib.postgres.fields import ArrayField

from li2.models import Campaign
from linkedin.portal_daemon.browser_session import parse_proxy_url
from linkedin.portal_daemon.exceptions import ProxyConfigError
from linkedin.portal_daemon.llm import render_prompt


# ─────────────── #1 working_hours field type ───────────────


def test_working_hours_is_array_field_not_jsonfield():
    field = Campaign._meta.get_field('working_hours')
    assert isinstance(field, ArrayField), (
        'working_hours column is Postgres text[]; a JSONField raises TypeError '
        'on json.loads(list) and crashes every Campaign read.'
    )


# ─────────────── #4 parse_proxy_url ───────────────


@pytest.mark.parametrize('raw', ['', '   ', None])
def test_proxy_empty_returns_none(raw):
    assert parse_proxy_url(raw) is None


def test_proxy_http_with_auth():
    assert parse_proxy_url('http://user:pass@1.2.3.4:8080') == {
        'server': 'http://1.2.3.4:8080', 'username': 'user', 'password': 'pass',
    }


def test_proxy_bare_host_port_defaults_to_http():
    assert parse_proxy_url('1.2.3.4:8080') == {'server': 'http://1.2.3.4:8080'}


def test_proxy_list_format_host_port_user_pass():
    assert parse_proxy_url('http://1.2.3.4:8080:bob:secret') == {
        'server': 'http://1.2.3.4:8080', 'username': 'bob', 'password': 'secret',
    }


def test_proxy_socks5_without_auth_ok():
    assert parse_proxy_url('socks5://1.2.3.4:1080') == {'server': 'socks5://1.2.3.4:1080'}


def test_proxy_prod_broken_socks5_with_auth_raises():
    # The literal value sitting in prod li2_settings — Chromium can't do
    # SOCKS5 auth, so this must fail loudly instead of exposing the real IP.
    with pytest.raises(ProxyConfigError):
        parse_proxy_url('socks5://45.149.131.142:63771:VtVmt51R:7GnJr2Yb')


def test_proxy_unknown_scheme_raises():
    with pytest.raises(ProxyConfigError):
        parse_proxy_url('ftp://1.2.3.4:21')


def test_proxy_missing_port_raises():
    with pytest.raises(ProxyConfigError):
        parse_proxy_url('http://garbage')


# ─────────────── #3 render_prompt (Jinja2) ───────────────


def test_render_missing_var_is_empty_not_placeholder():
    out = render_prompt('Product: {{ product_docs }}!', lead_name='Bob')
    assert '{{' not in out
    assert out == 'Product: !'


def test_render_substitutes_supplied_vars():
    out = render_prompt('Hi {{ lead_name }} at {{ lead_company }}',
                        lead_name='Bob', lead_company='Acme')
    assert out == 'Hi Bob at Acme'


def test_render_if_not_none_skips_on_none():
    tmpl = 'A{% if days_since_last_outgoing is not none %} {{ days_since_last_outgoing }}d{% endif %}B'
    assert render_prompt(tmpl, days_since_last_outgoing=None) == 'AB'
    assert render_prompt(tmpl, days_since_last_outgoing=3) == 'A 3dB'


def test_render_broken_template_does_not_raise():
    out = render_prompt('oops {{ unclosed', lead_name='Bob')
    assert isinstance(out, str)

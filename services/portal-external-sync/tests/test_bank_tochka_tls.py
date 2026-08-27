"""Доверие к УЦ Минцифры для Точки (sources/bank_tochka.py).

24.08.2026 Точка переехала на национальный УЦ. Его корня нет в наборе certifi,
которым httpx пользуется по умолчанию, и с 25.08 синк падал на рукопожатии:
«[SSL: CERTIFICATE_VERIFY_FAILED] self-signed certificate in certificate
chain». Четверо суток банковские выписки не грузились.

Чинится это добавлением корня, а не отключением проверки. Разница
принципиальная и незаметная в диффе: `verify=False` выглядит как правка на одну
строку, а означает, что ответ банка сможет подменить кто угодно на пути.
Поэтому тесты держат три вещи, каждая из которых защищает от своего способа
всё испортить:

  1) корень в репозитории — тот самый, а не какой-нибудь (сверка отпечатка);
  2) контекст действительно проверяет сертификаты, а не создан «пустым»;
  3) в контексте есть и корень Минцифры, и обычные корни certifi.

Сети тут нет: всё проверяется на файле и на объекте контекста.
"""
import ssl

import certifi
import pytest

from sources import bank_tochka


# Официальная раздача Госуслуг (gu-st.ru) и сертификат, который сервер Точки
# предъявляет в рукопожатии, дали один и тот же отпечаток. Если этот тест
# упал — значит файл в репозитории кто-то заменил, и прежде чем править
# константу, надо понять кто и зачем.
EXPECTED_SHA256 = "d26d2d0231b7c39f92cc738512ba54103519e4405d68b5bd703e9788ca8ecf31"


def test_root_ca_file_is_the_expected_certificate():
    assert bank_tochka.root_ca_fingerprint() == EXPECTED_SHA256


def test_context_verifies_certificates():
    """Проверка сертификата и имени хоста остаются включёнными.

    Самый вероятный способ «починить» будущий сбой — выключить их. Тест делает
    такую правку заметной: она уронит сборку, а не тихо доедет до прода.
    """
    ctx = bank_tochka.tochka_ssl_context()
    assert ctx.verify_mode == ssl.CERT_REQUIRED
    assert ctx.check_hostname is True


def test_context_trusts_ministry_root():
    ctx = bank_tochka.tochka_ssl_context()
    subjects = [
        value
        for cert in ctx.get_ca_certs()
        for rdn in cert.get("subject", ())
        for key, value in rdn
        if key == "commonName"
    ]
    assert "Russian Trusted Root CA" in subjects


def test_context_keeps_standard_roots():
    """Обычные корни никуда не деваются.

    Цепочка Точки сегодня целиком российская, но если банк вернётся на
    международный УЦ, соединение не должно сломаться второй раз по обратной
    причине.
    """
    ctx = bank_tochka.tochka_ssl_context()
    assert len(ctx.get_ca_certs()) > 10
    assert certifi.where()  # набор certifi доступен в образе


def test_missing_file_fails_loudly(monkeypatch, tmp_path):
    """Нет файла — падаем с объяснением, а не с невнятным отказом TLS.

    Ровно неразборчивость исходной ошибки и стоила четырёх суток простоя.
    """
    bank_tochka.tochka_ssl_context.cache_clear()
    monkeypatch.setattr(bank_tochka, "_ROOT_CA", tmp_path / "nope.pem")
    with pytest.raises(RuntimeError, match="Нет корневого сертификата"):
        bank_tochka.tochka_ssl_context()
    bank_tochka.tochka_ssl_context.cache_clear()


def test_tampered_file_is_refused(monkeypatch, tmp_path):
    """Подменённый корень — отказ, а не молчаливое доверие чужому УЦ."""
    fake = tmp_path / "fake.pem"
    fake.write_text(
        "-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n",
        encoding="utf-8",
    )
    bank_tochka.tochka_ssl_context.cache_clear()
    monkeypatch.setattr(bank_tochka, "_ROOT_CA", fake)
    with pytest.raises(RuntimeError, match="не совпал с ожидаемым отпечатком"):
        bank_tochka.tochka_ssl_context()
    bank_tochka.tochka_ssl_context.cache_clear()

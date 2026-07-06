"""Общая логика для Точки и Т-Банка: классификатор «выручка / не выручка», парсер дат.

Правила классификации взяты из скрипта CEO
(contour_code_archive_2026_06_26/polza_analytics/extract_banks.py).
"""
from __future__ import annotations

import os
from datetime import datetime, timezone

# ИП владельца — переводы себе не считаем выручкой. Через env,
# чтобы менять без пересборки образа.
OWN_INN = os.environ.get("BANK_OWN_INN", "165808519703").strip()

# Назначения платежа, которые не выручка от клиентов.
NON_REV_PURPOSE = (
    "возврат средств", "возврат операци", "возврат товара", "возврат покупки",
    "отмена операц", "овердраф", "card2card", "процент на остаток",
    "капитализац", "комиссия за", "вознаграждение банк", "начисление процентов",
)

# Плательщик = сам банк (овердрафт, кэшбэк, служебные операции).
BANK_PAYER = (
    "тбанк", "тинькофф", "банк точка", "точка банк", "пао сбербанк",
    "альфа-банк", "альфабанк",
)


def classify_revenue(payer: str, payer_inn: str, purpose: str) -> str:
    """Пусто → это выручка. Строка → причина исключения."""
    if payer_inn and payer_inn == OWN_INN:
        return "перевод себе (ИНН владельца)"
    pl = (purpose or "").lower()
    pn = (payer or "").lower()
    if any(k in pl for k in NON_REV_PURPOSE):
        return "банк-механика/возврат"
    # Плательщик — банк, но не через физлицо ("Тбанк // Иван Петров")
    if "//" not in (payer or "") and any(b in pn for b in BANK_PAYER):
        return "плательщик — банк"
    if "перевод по номеру телефона" in pl and ("никита" in pl or "ерхов" in pl):
        return "перевод себе (по телефону)"
    return ""


def parse_date(s: str | None) -> datetime | None:
    if not s:
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(s[:19], fmt).replace(tzinfo=timezone.utc)
        except (ValueError, TypeError):
            continue
    return None

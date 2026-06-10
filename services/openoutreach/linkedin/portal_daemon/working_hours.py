"""
Per-campaign working_hours check.

Campaign.working_hours — список окон вида ['09:33-13:02', '14:00-18:00'] в
local time (UTC + campaign.timezone_offset). Поддерживаем несколько окон
("утреннее" + "вечернее" типа выходных) — daemon shлёт инвайты/реплаи
ТОЛЬКО внутри этих окон.

`is_within(campaign, now_utc)` — True если now_utc в каком-нибудь окне.
`next_window_open(campaign, after_utc)` — datetime открытия следующего окна,
для перепланирования задач.
"""
from __future__ import annotations

from datetime import datetime, time, timedelta, timezone
from typing import Iterable


def _parse_window(window: str) -> tuple[time, time] | None:
    """'09:33-13:02' → (time(9,33), time(13,2))."""
    try:
        start_str, end_str = window.split('-', 1)
        start_h, start_m = map(int, start_str.strip().split(':', 1))
        end_h, end_m = map(int, end_str.strip().split(':', 1))
        return time(start_h, start_m), time(end_h, end_m)
    except (ValueError, AttributeError):
        return None


def _iter_windows(working_hours: list[str] | None) -> Iterable[tuple[time, time]]:
    for w in working_hours or []:
        parsed = _parse_window(w)
        if parsed:
            yield parsed


def _local_now(now_utc: datetime, tz_offset_hours: int) -> datetime:
    """Конвертим UTC → local time на основании timezone_offset кампании."""
    return now_utc + timedelta(hours=tz_offset_hours)


def is_within(working_hours: list[str] | None, tz_offset_hours: int, now_utc: datetime) -> bool:
    """True если now_utc в одном из окон с учётом tz_offset_hours."""
    if not working_hours:
        # Пустой список → "всегда работаем" (backward compat). Это сознательное
        # решение, чтобы кампания без указанных часов не зависала навечно.
        return True
    local_now = _local_now(now_utc, tz_offset_hours).time()
    for start, end in _iter_windows(working_hours):
        if start <= end:
            # Окно НЕ переходит через полночь: 09:33-13:02
            if start <= local_now < end:
                return True
        else:
            # Окно через полночь: 22:00-02:00 (редкий случай для outreach,
            # но синтаксически поддерживаем)
            if local_now >= start or local_now < end:
                return True
    return False


def next_window_open(working_hours: list[str] | None, tz_offset_hours: int, after_utc: datetime) -> datetime:
    """
    Когда откроется следующее окно (UTC). Если working_hours пустой — возвращаем
    after_utc (можно работать сразу). Если все окна "уже прошли сегодня" —
    берём первое окно следующего календарного дня.

    Алгоритм:
    1. Перебираем оба варианта (today, tomorrow), оба варианта окон.
    2. Для каждого окна считаем local_start.
    3. Если local_start > local_now — кандидат, конвертим в UTC.
    4. Берём минимум.
    """
    if not working_hours:
        return after_utc

    local_after = _local_now(after_utc, tz_offset_hours)
    candidates: list[datetime] = []

    for day_offset in (0, 1):
        for start, _end in _iter_windows(working_hours):
            local_day = (local_after + timedelta(days=day_offset)).date()
            local_candidate = datetime.combine(local_day, start, tzinfo=timezone.utc)
            # Конвертируем local → utc, вычитая tz_offset
            utc_candidate = local_candidate - timedelta(hours=tz_offset_hours)
            if utc_candidate > after_utc:
                candidates.append(utc_candidate)

    if not candidates:
        # Worst case fallback: завтра в полночь UTC + 12h. Не должно произойти
        # если working_hours парсятся корректно, но не оставляем без default'a.
        return after_utc + timedelta(hours=24)
    return min(candidates)

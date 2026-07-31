"""Автопривязка записей встреч (чат в телеграме) к сделкам AMO.

Дашборд первички считает «встречей» факт записи разговора в телеграм-чате
встреч, а не этап AMO «Встреча проведена + КП отправлено» — тот этап
засорён (200+ записей в месяц против ~64 у руководителя продаж). Подбор
сделки под запись — целиком в SQL-функции apply_meeting_deal_links() (см.
supabase/migrations/20260731_0001_meeting_deal_links.sql и
20260731_0002_meeting_deal_links_not_a_meeting.sql): её же зовёт кнопка
«Пересчитать привязки» на /analytics/first-sales
(app/src/app/api/analytics/first-sales/meeting-links/route.ts, POST). Вторая
реализация на Python значила бы два расходящихся ответа на один вопрос — тот
же принцип, что у expense_rules.py.

Место в SOURCES (main.py) — СТРОГО сразу после AmoCompanyEnrichSync(), а не
последним и не сразу после AmoSync(). Матчер сравнивает подпись записи с
amo_leads.company_name, а заполняет это поле именно AmoCompanyEnrichSync —
он ходит на сайт компании и вытаскивает название. Если поставить привязку
раньше (например сразу после AmoSync), у сделок, приехавших этой ночью,
company_name ещё будет пустым, и матчинг по названию (в отличие от матчинга
по домену, который берёт company_website напрямую из AmoSync) не сработает
до следующих суток. Ошибка при этом тихая: привязок просто меньше, ни одна
строка лога не покраснеет. Банки/курсы/расходы (BankTochkaSync и всё, что
идёт следом за ней) значения для этого источника не имеют — привязку от них
не зависит, поэтому специально не в самом хвосте списка: если что-то из
банков зависнет или упадёт выше по списку, это не должно откладывать то, что
уже готово запуститься.
"""
from __future__ import annotations

import asyncpg

from .base import SyncSource


class MeetingLinksSync(SyncSource):
    name = "meeting_links"

    async def run(self, conn: asyncpg.Connection) -> int:
        return int(await conn.fetchval("SELECT public.apply_meeting_deal_links()"))

"""AMO CRM → amo_notes: комментарии менеджеров по сделкам (note_type=common).

Зачем: команда договорилась 03.08.2026 отмечать каждое продление ОТДЕЛЬНЫМ
комментарием («Продление 1 - 159к», следующее продление — новый комментарий
«Продление 2 - 300к»), потому что у комментария есть собственная created_at,
и она и есть дата продления (см. supabase/migrations/20260803_0003_amo_notes.sql
и apply_renewal_marks() в 20260803_0004_renewal_marks_note_text.sql). До этой
договорённости такого сигнала не было: amo_events знает только смену этапа
воронки, amo_tasks — result.text задачи, ни там ни там нет отдельного события
с собственной датой на КАЖДОЕ продление.

Эндпойнт — GET /api/v4/leads/notes: комментарии по ВСЕМ сделкам разом (не
GET /api/v4/leads/{id}/notes по одной сделке), пагинация limit/page, 204 на
пустой странице (проба на проде 2026-08-03). Всего на проде 8033 записи всех
типов, из них common — 5189: то, что менеджер пишет руками. Это единственное,
что нам нужно — остальные типы (call_out/call_in/service_message/
extended_service_message/...) это звонки и системные записи.

Фильтр note_type=common — на стороне API (filter[note_type][]=common) И
продублирован здесь в _to_row: значение 'common' подтверждено самой пробой на
проде, а не угадано, поэтому дублирующий фильтр — просто защита от того, что
API-фильтр когда-нибудь подведёт, а не гадание вслепую.

entity_type НЕ используется как фильтр-дроп — в отличие от amo_tasks._to_row,
где filter[entity_type][]=leads на API дополнительно перепроверяется в
Python (там задачи бывают и по contacts/companies). Эндпойнт /leads/notes по
своей природе отдаёт комментарии только по сделкам — дополнительная проверка
entity_type здесь не защитила бы ни от чего, чего не защищает уже сам URL.

ОГРАНИЧЕНИЕ, важное для следующего человека: у комментария AMO нет
updated_at — только created_at (та же проба). Инкремент поэтому идёт по
max(created_at_amo), а НЕ max(updated_at_amo), как в amo_tasks.py. Следствие:
если комментарий отредактирован задним числом ПОСЛЕ того, как окно синка уже
ушло вперёд, новый текст повторно не приедет — инкрементальный watermark
читает только дату создания, а не факт правки. Для задачи продлений это не проблема
(в комментарий про продление пишут один раз и не правят по договорённости
команды), но следующий человек, который решит опереться на "текст в таблице
всегда актуален", должен знать про это ограничение заранее.

Инкрементально: окно = max(created_at_amo) уже сохранённых комментариев минус
нахлёст в двое суток, до фиксированной верхней границы, посчитанной один раз
до цикла страниц — тот же приём и то же обоснование, что в amo_tasks.py и
amo_events.py: источник истины для нижней границы — сама таблица amo_notes, а
не external_sync_runs (started_at отвечает "когда пытались", а не "докуда
дошли"). Если таблица пуста — 30 дней назад.

Если упёрлись в потолок MAX_PAGES — бросаем исключение с текстом окна и
числом уже загруженного, а не тихо возвращаем частичный результат. Upsert по
amo_note_id идёт постранично, поэтому падение не теряет уже сохранённое —
следующий прогон продолжит с max(created_at_amo) фактически сохранённого.
"""
from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime, timedelta, timezone

import asyncpg
import httpx

from .base import SyncSource

TOKEN = (os.environ.get("AMO_ACCESS_TOKEN") or os.environ.get("AMOCRM_TOKEN") or "").strip()
BASE_URL = os.environ.get("AMO_BASE_URL", "").strip().rstrip("/")

PAGE_LIMIT = int(os.environ.get("AMO_NOTES_PAGE_LIMIT", "250"))
MAX_PAGES = int(os.environ.get("AMO_NOTES_MAX_PAGES", "500"))
INTER_PAGE_DELAY_SEC = float(os.environ.get("AMO_INTER_PAGE_DELAY_SEC", "0.2"))
OVERLAP_DAYS = 2

# Единственный тип, который нас интересует — то, что менеджер пишет руками.
# Остальное (call_out/call_in/service_message/extended_service_message/...)
# — звонки и системные записи, см. докстринг модуля и миграцию.
NOTE_TYPE = "common"


class AmoNotesSync(SyncSource):
    #: Имя уже разрешено CHECK-констрейнтом external_sync_runs.source
    #: (supabase/migrations/20260803_0003_amo_notes.sql).
    name = "amo_notes"

    async def run(self, conn: asyncpg.Connection) -> int:
        if not TOKEN or not BASE_URL:
            raise NotImplementedError("AMO_ACCESS_TOKEN / AMO_BASE_URL не заданы")

        since = await self._watermark(conn)
        # Верхняя граница считается один раз, ДО цикла страниц — не внутри.
        # Иначе множество, по которому мы пагинируем, "уезжает" под ногами,
        # если во время прогона в AMO появляются новые комментарии, попадающие
        # в окно. Тот же приём, что в amo_tasks.py/amo_events.py.
        started_at = datetime.now(timezone.utc)
        headers = {"Authorization": f"Bearer {TOKEN}"}
        total = 0

        async with httpx.AsyncClient(timeout=60, headers=headers) as client:
            for page in range(1, MAX_PAGES + 1):
                url = (
                    f"{BASE_URL}/api/v4/leads/notes"
                    f"?limit={PAGE_LIMIT}&page={page}"
                    f"&filter[note_type][]={NOTE_TYPE}"
                    f"&filter[created_at][from]={int(since.timestamp())}"
                    f"&filter[created_at][to]={int(started_at.timestamp())}"
                )
                resp = await client.get(url)
                if resp.status_code == 204:
                    break  # AMO отдаёт 204 на пустой странице
                resp.raise_for_status()

                notes = (resp.json().get("_embedded") or {}).get("notes") or []
                if not notes:
                    break

                rows = [r for r in (self._to_row(n) for n in notes) if r is not None]
                if rows:
                    await self._upsert(conn, rows)
                    total += len(rows)

                if len(notes) < PAGE_LIMIT:
                    break  # неполная страница — окно вычерпано до конца

                await asyncio.sleep(INTER_PAGE_DELAY_SEC)
            else:
                # for-else: сюда попадаем, только если прошли все MAX_PAGES
                # итераций НИ РАЗУ не сделав break — то есть последняя
                # страница всё ещё была полной. Значит упёрлись в потолок
                # страниц, а не в конец данных. Молчать нельзя: часть окна
                # осталась не забрана. Всё, что успели, уже в БД (upsert шёл
                # постранично) — следующий прогон продолжит не с этой точки
                # во времени, а с max(created_at_amo) фактически сохранённого
                # (см. _watermark), поэтому падение не теряет уже сделанную
                # работу и не создаёт дыру.
                raise RuntimeError(
                    f"[{self.name}] упёрлись в MAX_PAGES={MAX_PAGES} "
                    f"(limit={PAGE_LIMIT}/стр.) на окне "
                    f"{since.isoformat()}..{started_at.isoformat()}; "
                    f"загружено {total} комментариев, но данные окна могли не "
                    f"закончиться — увеличьте AMO_NOTES_MAX_PAGES или "
                    f"AMO_NOTES_PAGE_LIMIT"
                )

        return total

    async def _watermark(self, conn: asyncpg.Connection) -> datetime:
        """Начало окна: max(created_at_amo) уже сохранённых комментариев минус
        нахлёст.

        Намеренно НЕ читаем external_sync_runs — тот же довод, что в
        amo_tasks.py/amo_events.py: started_at последнего прогона отвечает на
        «когда мы пытались», а нужен ответ на «докуда мы дошли». По
        created_at_amo, а НЕ updated_at_amo — у комментариев нет updated_at
        (см. докстринг модуля).

        Если таблица пуста (самый первый прогон, бэкфилла ещё не было) —
        берём месяц назад. Полную годовую глубину тянет отдельный
        бэкфилл-скрипт, а не ночной синк.
        """
        row = await conn.fetchrow("SELECT max(created_at_amo) AS ts FROM amo_notes")
        if row and row["ts"]:
            return row["ts"] - timedelta(days=OVERLAP_DAYS)

        return datetime.now(timezone.utc) - timedelta(days=30)

    @staticmethod
    def _to_row(note: dict) -> tuple | None:
        note_id = note.get("id")
        deal_id = note.get("entity_id")
        if not note_id or not deal_id:
            return None

        # Дублирующий фильтр — см. докстринг модуля про то, почему это не
        # гадание: 'common' подтверждено пробой на проде. Основной фильтр —
        # filter[note_type][]=common на стороне API; это подстраховка на
        # случай его регрессии.
        note_type = note.get("note_type")
        if note_type != NOTE_TYPE:
            return None

        created = note.get("created_at")
        if not created:
            return None
        created_at_amo = datetime.fromtimestamp(int(created), tz=timezone.utc)

        # params может отсутствовать целиком или быть не dict — не должно
        # ронять маппинг, часть common-записей может быть без текста.
        params = note.get("params")
        text = params.get("text") if isinstance(params, dict) else None

        return (
            int(note_id),
            int(deal_id),
            note_type,
            text,
            created_at_amo,
            note.get("created_by"),
            json.dumps(note, ensure_ascii=False),
        )

    @staticmethod
    async def _upsert(conn: asyncpg.Connection, rows: list[tuple]) -> None:
        await conn.executemany(
            """INSERT INTO amo_notes (
                 amo_note_id, amo_deal_id, note_type, text,
                 created_at_amo, created_by, raw
               ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
               ON CONFLICT (amo_note_id) DO UPDATE SET
                 amo_deal_id    = EXCLUDED.amo_deal_id,
                 note_type      = EXCLUDED.note_type,
                 text           = EXCLUDED.text,
                 created_at_amo = EXCLUDED.created_at_amo,
                 created_by     = EXCLUDED.created_by,
                 raw            = EXCLUDED.raw,
                 synced_at      = now()""",
            rows,
        )

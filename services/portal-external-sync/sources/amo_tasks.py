"""AMO CRM → amo_tasks: результаты выполненных задач по сделкам.

Зачем: результат задачи (result.text) — единственный из трёх сигналов
продления (см. docs/superpowers/plans/2026-08-03-renewals-from-payments.md),
где есть прямое человеческое высказывание с суммой — менеджер пишет
«Оплатили продление 159к» прямым текстом. amo_events по сравнению с этим
знает только смену этапа воронки, а не то, что человек написал по факту.

Тянем ВСЕ задачи (is_completed true и false), не только выполненные:
незавершённая сегодня задача завтра станет выполненной, и обычный
инкремент по updated_at её подхватит сам — отдельного повторного прохода
по «дозревшим» задачам не нужно.

entity_type фильтруется на стороне API (filter[entity_type][]=leads), а не
после получения: amo_deal_id в нашей схеме NOT NULL, а у задач по контактам
и компаниям (entity_type=contacts/companies) вообще нет ID сделки — их
попросту некуда класть. Заодно это экономит объём: на боевых 2026-08-03
задачи есть не только по сделкам, а серверный фильтр не тратит лимит
страниц на то, что мы всё равно выбросим.

Инкрементально: окно = max(updated_at_amo) уже сохранённых задач минус
нахлёст в двое суток (AMO может отдать обновление с задержкой), до момента
старта прогона. Единственный источник истины для нижней границы — сама
таблица amo_tasks, а не лог прогонов (external_sync_runs.started_at
отвечает на «когда мы пытались», а не «докуда дошли» — тот же довод, что в
sources/amo_events.py). Верхняя граница фиксируется один раз до пагинации,
чтобы задачи, обновившиеся во время прогона, не сдвигали то, по чему мы уже
пагинируем. Upsert по amo_task_id (не append-only, в отличие от amo_events:
одна и та же задача переиспользуется — сначала создаётся, потом у неё
меняются is_completed/result.text — а не создаётся заново).

Если упёрлись в потолок MAX_PAGES (данные внутри окна не кончились, а
кончился лимит страниц) — бросаем исключение, а не тихо возвращаем частичный
результат. Всё уже загруженное к этому моменту уже закоммичено в amo_tasks,
поэтому следующий прогон честно продолжит с max(updated_at_amo) фактически
сохранённого, а не перепрыгнет забытый хвост.

Нет SET LOCAL statement_timeout вокруг апсерта: в отличие от meeting_links.py
(который зовёт тяжёлую SQL-функцию, пересматривающую ВСЕ строки на каждый
прогон), здесь постраничный executemany над уже ограниченным HTTP-ответом —
тот же характер нагрузки, что у amo_events.py, где такого лимита тоже нет.

Объём (см. отчёт по Task 1 плана): за 12 месяцев ~15 тысяч ВЫПОЛНЕННЫХ задач
(плюс невыполненные — которые мы тоже тянем). При PAGE_LIMIT=250 полная
годовая выгрузка — это порядка 60+ страниц, но её делает не этот источник:
ночной инкремент видит только 30-дневное окно на первом прогоне (пустая
таблица) и единицы страниц на каждом следующем. Полный бэкфилл — отдельный
скрипт по образцу app/scripts/backfill-amo-events.mjs, ещё не написан.
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

PAGE_LIMIT = int(os.environ.get("AMO_TASKS_PAGE_LIMIT", "250"))
MAX_PAGES = int(os.environ.get("AMO_TASKS_MAX_PAGES", "500"))
INTER_PAGE_DELAY_SEC = float(os.environ.get("AMO_INTER_PAGE_DELAY_SEC", "0.2"))
OVERLAP_DAYS = 2

# Сделки — единственный entity_type, для которого в нашей схеме есть куда
# положить amo_deal_id. Задачи по contacts/companies фильтруются на стороне
# API (см. докстринг модуля) и никогда сюда не доходят.
ENTITY_TYPE = "leads"


class AmoTasksSync(SyncSource):
    #: Имя уже разрешено CHECK-констрейнтом external_sync_runs.source
    #: (supabase/migrations/20260803_0001_amo_tasks.sql).
    name = "amo_tasks"

    async def run(self, conn: asyncpg.Connection) -> int:
        if not TOKEN or not BASE_URL:
            raise NotImplementedError("AMO_ACCESS_TOKEN / AMO_BASE_URL не заданы")

        since = await self._watermark(conn)
        # Верхняя граница считается один раз, ДО цикла страниц — не внутри.
        # Иначе множество, по которому мы пагинируем, "уезжает" под ногами,
        # если во время прогона в AMO обновляются задачи, попадающие в окно.
        started_at = datetime.now(timezone.utc)
        headers = {"Authorization": f"Bearer {TOKEN}"}
        total = 0

        async with httpx.AsyncClient(timeout=60, headers=headers) as client:
            for page in range(1, MAX_PAGES + 1):
                url = (
                    f"{BASE_URL}/api/v4/tasks"
                    f"?limit={PAGE_LIMIT}&page={page}"
                    f"&filter[entity_type][]={ENTITY_TYPE}"
                    f"&filter[updated_at][from]={int(since.timestamp())}"
                    f"&filter[updated_at][to]={int(started_at.timestamp())}"
                )
                resp = await client.get(url)
                if resp.status_code == 204:
                    break  # AMO отдаёт 204 на пустой странице
                resp.raise_for_status()

                tasks = (resp.json().get("_embedded") or {}).get("tasks") or []
                if not tasks:
                    break

                rows = [r for r in (self._to_row(t) for t in tasks) if r is not None]
                if rows:
                    await self._upsert(conn, rows)
                    total += len(rows)

                if len(tasks) < PAGE_LIMIT:
                    break  # неполная страница — окно вычерпано до конца

                await asyncio.sleep(INTER_PAGE_DELAY_SEC)
            else:
                # for-else: сюда попадаем, только если прошли все MAX_PAGES
                # итераций НИ РАЗУ не сделав break — то есть последняя
                # страница всё ещё была полной. Значит упёрлись в потолок
                # страниц, а не в конец данных. Молчать нельзя: часть окна
                # осталась не забрана. Всё, что успели, уже в БД (upsert шёл
                # постранично) — следующий прогон продолжит не с этой точки
                # во времени, а с max(updated_at_amo) фактически сохранённого
                # (см. _watermark), поэтому падение не теряет уже сделанную
                # работу и не создаёт дыру.
                raise RuntimeError(
                    f"[{self.name}] упёрлись в MAX_PAGES={MAX_PAGES} "
                    f"(limit={PAGE_LIMIT}/стр.) на окне "
                    f"{since.isoformat()}..{started_at.isoformat()}; "
                    f"загружено {total} задач, но данные окна могли не "
                    f"закончиться — увеличьте AMO_TASKS_MAX_PAGES или "
                    f"AMO_TASKS_PAGE_LIMIT"
                )

        return total

    async def _watermark(self, conn: asyncpg.Connection) -> datetime:
        """Начало окна: max(updated_at_amo) уже сохранённых задач минус нахлёст.

        Намеренно НЕ читаем external_sync_runs — тот же довод, что в
        sources/amo_events.py: started_at последнего прогона отвечает на
        «когда мы пытались», а нужен ответ на «докуда мы дошли». Эти вопросы
        расходятся ровно тогда, когда прогон упал или был усечён по
        MAX_PAGES — то есть именно тогда, когда цена ошибки максимальна.
        max(updated_at_amo) по самой таблице отражает фактически
        сохранённое и потому не может разъехаться с реальностью.

        Если таблица пуста (самый первый прогон, бэкфилла ещё не было) —
        берём месяц назад. Полную годовую глубину тянет отдельный
        бэкфилл-скрипт, а не ночной синк: тяжёлый прогон в штатном окне
        задержал бы все источники, идущие следом.
        """
        row = await conn.fetchrow("SELECT max(updated_at_amo) AS ts FROM amo_tasks")
        if row and row["ts"]:
            return row["ts"] - timedelta(days=OVERLAP_DAYS)

        return datetime.now(timezone.utc) - timedelta(days=30)

    @staticmethod
    def _to_row(task: dict) -> tuple | None:
        task_id = task.get("id")
        deal_id = task.get("entity_id")
        if not task_id or not deal_id or task.get("entity_type") != ENTITY_TYPE:
            return None

        updated = task.get("updated_at")
        if not updated:
            return None
        updated_at_amo = datetime.fromtimestamp(int(updated), tz=timezone.utc)

        created = task.get("created_at")
        created_at_amo = (
            datetime.fromtimestamp(int(created), tz=timezone.utc) if created else None
        )

        complete_till_raw = task.get("complete_till")
        complete_till = (
            datetime.fromtimestamp(int(complete_till_raw), tz=timezone.utc)
            if complete_till_raw
            else None
        )

        # result отсутствует у части задач (не только у невыполненных —
        # выполненная задача без заполненного результата тоже валидна, см.
        # комментарий к amo_tasks.result_text в миграции). .get(...) или {}
        # + .get("text") не роняется ни на отсутствующем ключе, ни на None.
        result = task.get("result") or {}
        result_text = result.get("text") if isinstance(result, dict) else None

        return (
            int(task_id),
            int(deal_id),
            task.get("is_completed"),
            result_text,
            task.get("text"),
            task.get("task_type_id"),
            task.get("responsible_user_id"),
            task.get("created_by"),
            complete_till,
            created_at_amo,
            updated_at_amo,
            json.dumps(task, ensure_ascii=False),
        )

    @staticmethod
    async def _upsert(conn: asyncpg.Connection, rows: list[tuple]) -> None:
        await conn.executemany(
            """INSERT INTO amo_tasks (
                 amo_task_id, amo_deal_id, is_completed, result_text, text,
                 task_type_id, responsible_user_id, created_by,
                 complete_till, created_at_amo, updated_at_amo, raw
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
               ON CONFLICT (amo_task_id) DO UPDATE SET
                 amo_deal_id         = EXCLUDED.amo_deal_id,
                 is_completed        = EXCLUDED.is_completed,
                 result_text         = EXCLUDED.result_text,
                 text                = EXCLUDED.text,
                 task_type_id        = EXCLUDED.task_type_id,
                 responsible_user_id = EXCLUDED.responsible_user_id,
                 created_by          = EXCLUDED.created_by,
                 complete_till       = EXCLUDED.complete_till,
                 created_at_amo      = EXCLUDED.created_at_amo,
                 updated_at_amo      = EXCLUDED.updated_at_amo,
                 raw                 = EXCLUDED.raw,
                 synced_at           = now()""",
            rows,
        )

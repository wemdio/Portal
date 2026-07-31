"""AMO CRM → amo_events: история переходов сделок по этапам.

Зачем: в amo_leads есть только ТЕКУЩИЙ этап сделки. Без истории нельзя
ответить «сколько встреч провели во вторник» — можно только «из лидов
вторника дошли до встречи», а это когортная метрика, которая едет задним
числом. Дашборд первички считает встречи и договоры по дате перехода.

Инкрементально: окно = max(changed_at) уже сохранённых событий минус нахлёст
в двое суток (AMO может отдать событие с задержкой), до момента старта
прогона. Единственный источник истины для нижней границы — сама таблица, а
не лог прогонов (external_sync_runs.started_at отвечает на «когда мы
пытались», а не «докуда дошли» — эти вопросы расходятся ровно тогда, когда
что-то пошло не так). Верхняя граница фиксируется один раз до пагинации,
чтобы новые события, появившиеся во время прогона, не сдвигали то, по чему
мы уже пагинируем. Уникальный ключ (amo_deal_id, event_type, changed_at)
делает повторный прогон безвредным.

Если упёрлись в потолок MAX_PAGES (данные внутри окна не кончились, а
кончился лимит страниц) — бросаем исключение, а не тихо возвращаем частичный
результат. Всё уже загруженное к этому моменту уже закоммичено в amo_events,
поэтому следующий прогон честно продолжит с максимума фактически
сохранённого, а не перепрыгнет забытый хвост.

Разовый бэкфилл за всю глубину — app/scripts/backfill-amo-events.mjs.
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

PAGE_LIMIT = int(os.environ.get("AMO_EVENTS_PAGE_LIMIT", "100"))
MAX_PAGES = int(os.environ.get("AMO_EVENTS_MAX_PAGES", "500"))
INTER_PAGE_DELAY_SEC = float(os.environ.get("AMO_INTER_PAGE_DELAY_SEC", "0.2"))
OVERLAP_DAYS = 2

EVENT_TYPE = "lead_status_changed"


class AmoEventsSync(SyncSource):
    #: Имя уже разрешено CHECK-констрейнтом external_sync_runs.source.
    name = "amo_events"

    async def run(self, conn: asyncpg.Connection) -> int:
        if not TOKEN or not BASE_URL:
            raise NotImplementedError("AMO_ACCESS_TOKEN / AMO_BASE_URL не заданы")

        since = await self._watermark(conn)
        # Верхняя граница считается один раз, ДО цикла страниц — не внутри.
        # Иначе множество, по которому мы пагинируем, "уезжает" под ногами,
        # если во время прогона в AMO появляются новые подходящие события
        # (риск реален независимо от порядка сортировки на стороне AMO,
        # который нигде не задокументирован и не гарантирован).
        started_at = datetime.now(timezone.utc)
        headers = {"Authorization": f"Bearer {TOKEN}"}
        total = 0

        async with httpx.AsyncClient(timeout=60, headers=headers) as client:
            for page in range(1, MAX_PAGES + 1):
                url = (
                    f"{BASE_URL}/api/v4/events"
                    f"?limit={PAGE_LIMIT}&page={page}"
                    f"&filter[type][]={EVENT_TYPE}"
                    f"&filter[created_at][from]={int(since.timestamp())}"
                    f"&filter[created_at][to]={int(started_at.timestamp())}"
                )
                resp = await client.get(url)
                if resp.status_code == 204:
                    break  # AMO отдаёт 204 на пустой странице
                resp.raise_for_status()

                events = (resp.json().get("_embedded") or {}).get("events") or []
                if not events:
                    break

                rows = [r for r in (self._to_row(e) for e in events) if r is not None]
                if rows:
                    await self._upsert(conn, rows)
                    total += len(rows)

                if len(events) < PAGE_LIMIT:
                    break  # неполная страница — окно вычерпано до конца

                await asyncio.sleep(INTER_PAGE_DELAY_SEC)
            else:
                # for-else: сюда попадаем, только если прошли все MAX_PAGES
                # итераций НИ РАЗУ не сделав break — то есть последняя
                # страница всё ещё была полной. Значит упёрлись в потолок
                # страниц, а не в конец данных. Молчать нельзя: часть окна
                # осталась не забрана. Всё, что успели, уже в БД (upsert
                # шёл постранично) — следующий прогон продолжит не с этой
                # точки во времени, а с max(changed_at) фактически
                # сохранённого (см. _watermark), поэтому падение не теряет
                # уже сделанную работу и не создаёт дыру.
                raise RuntimeError(
                    f"[{self.name}] упёрлись в MAX_PAGES={MAX_PAGES} "
                    f"(limit={PAGE_LIMIT}/стр.) на окне "
                    f"{since.isoformat()}..{started_at.isoformat()}; "
                    f"загружено {total} событий, но данные окна могли не "
                    f"закончиться — увеличьте AMO_EVENTS_MAX_PAGES или "
                    f"AMO_EVENTS_PAGE_LIMIT"
                )

        return total

    async def _watermark(self, conn: asyncpg.Connection) -> datetime:
        """Начало окна: max(changed_at) уже сохранённых событий минус нахлёст.

        Намеренно НЕ читаем external_sync_runs. started_at последнего
        успешного прогона отвечает на вопрос «когда мы пытались», а нужен
        ответ на «докуда мы дошли». Эти вопросы расходятся ровно тогда, когда
        прогон упал или был усечён по MAX_PAGES — то есть именно тогда, когда
        цена ошибки максимальна. max(changed_at) по самой таблице отражает
        фактически сохранённое и потому не может разъехаться с реальностью:
        что записали, то и видим. Побочный эффект: эту логику больше нельзя
        сломать, неверно проставив status='success'.

        Если таблица пуста (самый первый прогон, бэкфилл ещё не делали) —
        берём месяц назад. Полную глубину тянет отдельный бэкфилл-скрипт, а
        не ночной синк: тяжёлый прогон в штатном окне задержал бы все
        следующие источники.
        """
        row = await conn.fetchrow("SELECT max(changed_at) AS ts FROM amo_events")
        if row and row["ts"]:
            return row["ts"] - timedelta(days=OVERLAP_DAYS)

        return datetime.now(timezone.utc) - timedelta(days=30)

    @staticmethod
    def _to_row(event: dict) -> tuple | None:
        deal_id = event.get("entity_id")
        if not deal_id or event.get("entity_type") != "lead":
            return None

        created = event.get("created_at")
        if not created:
            return None
        changed_at = datetime.fromtimestamp(int(created), tz=timezone.utc)

        def status_of(side: str) -> str | None:
            arr = event.get(side) or []
            if not arr:
                return None
            node = (arr[0] or {}).get("lead_status") or {}
            sid = node.get("id")
            return str(sid) if sid is not None else None

        return (
            int(deal_id),
            EVENT_TYPE,
            changed_at,
            event.get("created_by"),
            status_of("value_before"),
            status_of("value_after"),
            json.dumps(event, ensure_ascii=False),
        )

    @staticmethod
    async def _upsert(conn: asyncpg.Connection, rows: list[tuple]) -> None:
        await conn.executemany(
            """INSERT INTO amo_events (
                 amo_deal_id, event_type, changed_at, changed_by,
                 from_value, to_value, payload
               ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
               ON CONFLICT (amo_deal_id, event_type, changed_at) DO UPDATE SET
                 from_value = EXCLUDED.from_value,
                 to_value   = EXCLUDED.to_value,
                 payload    = EXCLUDED.payload,
                 synced_at  = now()""",
            rows,
        )

"""Yandex Metrika → metrika_visits_daily.

Ежедневная агрегация визитов по источникам трафика. Тянем LOOKBACK_DAYS назад,
UPSERT по (date, traffic_source) — старые дни могут скорректироваться.

Per-visit детализация (metrika_visits с ym_client_id) — отдельная задача, требует
Metrika Logs API. Здесь пока только агрегат.
"""
from __future__ import annotations

import os
from datetime import date, datetime, timedelta

import asyncpg
import httpx

from .base import SyncSource

TOKEN = os.environ.get("YANDEX_METRIKA_TOKEN", "").strip()
COUNTER = int(os.environ.get("YANDEX_METRIKA_COUNTER_ID", "62363425"))  # polzaagency.ru
LOOKBACK_DAYS = int(os.environ.get("YANDEX_METRIKA_LOOKBACK_DAYS", "30"))

API_URL = "https://api-metrika.yandex.net/stat/v1/data"


class MetrikaSync(SyncSource):
    name = "metrika"

    async def run(self, conn: asyncpg.Connection) -> int:
        if not TOKEN:
            raise NotImplementedError("YANDEX_METRIKA_TOKEN не задан")

        end = date.today()
        start = end - timedelta(days=LOOKBACK_DAYS)

        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.get(
                API_URL,
                headers={"Authorization": f"OAuth {TOKEN}"},
                params={
                    "ids": COUNTER,
                    "metrics": "ym:s:visits,ym:s:users,ym:s:bounceRate",
                    "dimensions": "ym:s:date,ym:s:lastTrafficSource",
                    "date1": start.isoformat(),
                    "date2": end.isoformat(),
                    "limit": 10000,
                    "accuracy": "full",
                },
            )
            resp.raise_for_status()
            data = resp.json()

        rows: list[tuple] = []
        for r in data.get("data", []):
            dims = r.get("dimensions") or []
            metrics = r.get("metrics") or []
            if len(dims) < 2 or len(metrics) < 3:
                continue
            d_name = dims[0].get("name") or ""
            src = dims[1].get("name") or "(не определён)"
            try:
                d = datetime.strptime(d_name, "%Y-%m-%d").date()
            except ValueError:
                continue
            visits = int(metrics[0] or 0)
            users = int(metrics[1] or 0)
            bounce = metrics[2]
            bounce_rounded = round(float(bounce), 2) if bounce is not None else None
            rows.append((d, src, visits, users, bounce_rounded))

        if not rows:
            return 0

        await conn.executemany(
            """INSERT INTO metrika_visits_daily
                   (date, traffic_source, visits, users, bounce_rate)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (date, traffic_source) DO UPDATE
                 SET visits      = EXCLUDED.visits,
                     users       = EXCLUDED.users,
                     bounce_rate = EXCLUDED.bounce_rate,
                     synced_at   = now()""",
            rows,
        )
        return len(rows)

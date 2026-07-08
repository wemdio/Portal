"""AMO CRM → amo_leads.

Тянет все сделки с pagination (/api/v4/leads?with=contacts,companies).
Извлекает основные поля + custom-field ym_client_id (id из AMO_FIELD_YM_CLIENT_ID).
Всё сырое кладём в `raw jsonb` — для полей, которые не вытащены отдельными
колонками (contact phone/email, company_name, история статусов), пользователь
всегда может достать через `raw->>'field'`.

UPSERT по amo_id. При повторном прогоне обновляем изменяемые поля
(status, price, updated_at, closed_at, raw).
"""
from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime, timezone
from typing import Any

import asyncpg
import httpx

from .base import SyncSource

TOKEN = (os.environ.get("AMO_ACCESS_TOKEN") or os.environ.get("AMOCRM_TOKEN") or "").strip()
BASE_URL = os.environ.get("AMO_BASE_URL", "").strip().rstrip("/")
YM_FIELD_ID = os.environ.get("AMO_FIELD_YM_CLIENT_ID", "1292201").strip()

PAGE_LIMIT = int(os.environ.get("AMO_PAGE_LIMIT", "250"))
MAX_PAGES = int(os.environ.get("AMO_MAX_PAGES", "500"))
INTER_PAGE_DELAY_SEC = float(os.environ.get("AMO_INTER_PAGE_DELAY_SEC", "0.2"))


def _ts(unix: int | None) -> datetime | None:
    return datetime.fromtimestamp(unix, tz=timezone.utc) if unix else None


def _cf_map(lead: dict[str, Any]) -> dict[str, Any]:
    """{field_id (str) → value} по custom_fields_values сделки."""
    out: dict[str, Any] = {}
    for f in lead.get("custom_fields_values") or []:
        vals = f.get("values") or []
        if vals:
            out[str(f.get("field_id"))] = vals[0].get("value")
    return out


class AmoSync(SyncSource):
    name = "amo_leads"

    async def run(self, conn: asyncpg.Connection) -> int:
        if not TOKEN or not BASE_URL:
            raise NotImplementedError("AMO_ACCESS_TOKEN / AMO_BASE_URL не заданы")

        base = BASE_URL if BASE_URL.startswith("http") else f"https://{BASE_URL}"
        headers = {"Authorization": f"Bearer {TOKEN}"}

        upserted = 0
        async with httpx.AsyncClient(timeout=60, headers=headers) as client:
            page = 1
            while page <= MAX_PAGES:
                url = f"{base}/api/v4/leads?limit={PAGE_LIMIT}&page={page}&with=contacts,companies"
                resp = await client.get(url)
                if resp.status_code == 204:
                    break  # AMO отдаёт 204 на пустой странице
                resp.raise_for_status()
                data = resp.json()
                leads = ((data.get("_embedded") or {}).get("leads")) or []
                if not leads:
                    break

                rows = [self._to_row(lead) for lead in leads]
                await self._upsert(conn, rows)
                upserted += len(rows)

                if not ((data.get("_links") or {}).get("next")):
                    break
                page += 1
                await asyncio.sleep(INTER_PAGE_DELAY_SEC)

        return upserted

    def _to_row(self, lead: dict[str, Any]) -> tuple:
        cf = _cf_map(lead)
        # company_id доступен из _embedded, но name требует отдельного запроса —
        # для MVP оставляем null, полный контекст в raw.
        return (
            lead["id"],
            lead.get("name"),
            lead.get("status_id"),
            None,  # status_name — потребует /api/v4/leads/pipelines
            lead.get("pipeline_id"),
            None,  # pipeline_name — то же
            lead.get("price"),
            lead.get("responsible_user_id"),
            None,  # responsible_name — потребует /api/v4/users
            cf.get(YM_FIELD_ID),
            None,  # contact_phone — потребует /api/v4/contacts/{id}
            None,  # contact_email — то же
            None,  # company_name — потребует /api/v4/companies/{id}
            _ts(lead.get("created_at")),
            _ts(lead.get("updated_at")),
            _ts(lead.get("closed_at")),
            json.dumps(lead, ensure_ascii=False),
        )

    async def _upsert(self, conn: asyncpg.Connection, rows: list[tuple]) -> None:
        await conn.executemany(
            """INSERT INTO amo_leads (
                 amo_id, name, status_id, status_name, pipeline_id, pipeline_name,
                 amount, responsible_user_id, responsible_name,
                 ym_client_id, contact_phone, contact_email, company_name,
                 created_at, updated_at, closed_at, raw
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
               ON CONFLICT (amo_id) DO UPDATE SET
                 name                = EXCLUDED.name,
                 status_id           = EXCLUDED.status_id,
                 pipeline_id         = EXCLUDED.pipeline_id,
                 amount              = EXCLUDED.amount,
                 responsible_user_id = EXCLUDED.responsible_user_id,
                 ym_client_id        = EXCLUDED.ym_client_id,
                 updated_at          = EXCLUDED.updated_at,
                 closed_at           = EXCLUDED.closed_at,
                 raw                 = EXCLUDED.raw,
                 synced_at           = now()""",
            rows,
        )

"""AMO CRM → amo_leads (+ amo_users, amo_statuses lookup tables).

Тянет:
- pipelines (`/api/v4/leads/pipelines`) — один запрос, разворачивает в amo_statuses.
- users (`/api/v4/users`) — 1-2 страницы, разворачивает в amo_users.
- contacts (`/api/v4/contacts?with=…`) — все контакты страницами, кэшируется
  in-memory как {id → (phone, email)} для обогащения leads.
- companies (`/api/v4/companies`) — то же, кэш {id → name}.
- leads (`/api/v4/leads?with=contacts,companies`) — основной цикл, при формировании
  строки подтягивает имена/телефоны/email из in-memory кэшей.

UPSERT по amo_id (leads), id (users), (pipeline_id, status_id) (statuses).
Повторный прогон безопасен — все таблицы UPSERT-only.

История полей: до этого мажора status_name, pipeline_name, responsible_name,
contact_phone, contact_email, company_name лежали как NULL (у всех 5553 сделок).
Причина — AMO не отдаёт человекочитаемые имена в /api/v4/leads, только id.
С этого мажора заполняем через lookup таблицы + in-memory кэши.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from datetime import datetime, timezone
from typing import Any

import asyncpg
import httpx

from .base import SyncSource

# Regex для fallback-извлечения TG-юзера из названия сделки: `@nickname от Х`.
# Минимум 5 символов — чтобы отсеять `@x` в русских текстах и служебные @.
TG_USERNAME_RE = re.compile(r"@([A-Za-z][A-Za-z0-9_]{4,31})\b")

TOKEN = (os.environ.get("AMO_ACCESS_TOKEN") or os.environ.get("AMOCRM_TOKEN") or "").strip()
BASE_URL = os.environ.get("AMO_BASE_URL", "").strip().rstrip("/")
YM_FIELD_ID = os.environ.get("AMO_FIELD_YM_CLIENT_ID", "1292201").strip()

PAGE_LIMIT = int(os.environ.get("AMO_PAGE_LIMIT", "250"))
MAX_PAGES = int(os.environ.get("AMO_MAX_PAGES", "500"))
INTER_PAGE_DELAY_SEC = float(os.environ.get("AMO_INTER_PAGE_DELAY_SEC", "0.2"))

HTTP_RETRIES = int(os.environ.get("AMO_HTTP_RETRIES", "3"))
HTTP_RETRY_DELAY_SEC = float(os.environ.get("AMO_HTTP_RETRY_DELAY_SEC", "2"))


async def get_with_retry(client: httpx.AsyncClient, url: str) -> httpx.Response:
    """GET к AMO с повтором на обрыве связи и 5xx.

    Зачем: с 01.07 по 04.08.2026 источник amo_leads упал 8 раз из 52 прогонов,
    каждый раз с «Server disconnected without sending a response.» — AMO рвёт
    соединение на ровном месте. Одна неудачная попытка роняла весь синк, и
    отчёты в 17:00 считались по вчерашнему снимку, причём молча.

    Ловим httpx.TransportError — это общий родитель для обрывов, таймаутов и
    RemoteProtocolError, то есть всех «связь не задалась». Ошибки уровня
    протокола AMO (4xx) не повторяем: они не про связь, повтор их не вылечит.
    5xx повторяем — это чаще всего временная перегрузка на стороне AMO.

    Пауза удваивается: 2 с, затем 4 с. После последней попытки исключение
    пробрасывается наверх, и падение источника логируется как раньше.
    """
    for attempt in range(1, HTTP_RETRIES + 1):
        is_last = attempt == HTTP_RETRIES
        try:
            resp = await client.get(url)
        except httpx.TransportError as e:
            if is_last:
                raise
            print(
                f"[amo] попытка {attempt}/{HTTP_RETRIES} не удалась ({e!r}) — повтор",
                flush=True,
            )
        else:
            if resp.status_code < 500 or is_last:
                return resp
            print(
                f"[amo] попытка {attempt}/{HTTP_RETRIES} вернула "
                f"{resp.status_code} — повтор",
                flush=True,
            )
        await asyncio.sleep(HTTP_RETRY_DELAY_SEC * 2 ** (attempt - 1))
    raise RuntimeError("get_with_retry: недостижимая ветка")


def _ts(unix: int | None) -> datetime | None:
    return datetime.fromtimestamp(unix, tz=timezone.utc) if unix else None


def _cf_map(entity: dict[str, Any]) -> dict[str, Any]:
    """{field_id (str) → value} по custom_fields_values любой сущности AMO."""
    out: dict[str, Any] = {}
    for f in entity.get("custom_fields_values") or []:
        vals = f.get("values") or []
        if vals:
            out[str(f.get("field_id"))] = vals[0].get("value")
    return out


def _cf_by_code(entity: dict[str, Any], code: str) -> str | None:
    """Первое значение из custom_fields_values по коду поля (PHONE, EMAIL, ...)."""
    for f in entity.get("custom_fields_values") or []:
        if (f.get("field_code") or "").upper() == code.upper():
            vals = f.get("values") or []
            if vals:
                v = vals[0].get("value")
                return str(v) if v is not None else None
    return None


def _main_contact_id(lead: dict[str, Any]) -> int | None:
    """Возвращает id основного контакта сделки; если main нет — первый."""
    contacts = ((lead.get("_embedded") or {}).get("contacts")) or []
    if not contacts:
        return None
    for c in contacts:
        if c.get("is_main"):
            return c.get("id")
    return contacts[0].get("id")


def _first_company_id(lead: dict[str, Any]) -> int | None:
    companies = ((lead.get("_embedded") or {}).get("companies")) or []
    return companies[0].get("id") if companies else None


def _tg_from_contact(contact: dict[str, Any]) -> str | None:
    """Ищет TG-юзера в custom_fields контакта. Три источника (в порядке приоритета):
    1) IM-поле (field_code=IM) с enum_code=TELEGRAM.
    2) Любое поле, где field_code содержит TG/TELEGRAM.
    3) Любое поле, где field_name содержит Telegram/Тг/ТГ.
    Возвращает username без ведущего @, иначе None.
    """
    for f in contact.get("custom_fields_values") or []:
        code = (f.get("field_code") or "").upper()
        name = (f.get("field_name") or "").lower()
        values = f.get("values") or []
        for v in values:
            enum_code = (v.get("enum_code") or "").upper()
            raw_val = v.get("value")
            if not raw_val:
                continue
            val = str(raw_val).strip()
            hit = (
                (code == "IM" and enum_code == "TELEGRAM")
                or code in ("TG", "TELEGRAM")
                or "telegram" in name
                or "тг" in name
            )
            if hit:
                return val.lstrip("@").split("/")[-1].split("?")[0] or None
    return None


def _extract_website_from_lead(lead: dict[str, Any]) -> str | None:
    """Достаёт сайт из custom-поля «Сайт», нормализует.
    Убирает протокол, www., trailing slash, path. Полезно для матча и индексации.
    """
    for f in lead.get("custom_fields_values") or []:
        if (f.get("field_name") or "").strip().lower() != "сайт":
            continue
        vals = f.get("values") or []
        if not vals:
            return None
        raw = str(vals[0].get("value") or "").strip()
        if not raw:
            return None
        s = raw.lower()
        s = re.sub(r"^https?://", "", s)
        s = re.sub(r"^www\.", "", s)
        s = s.split("/", 1)[0]
        s = s.split("?", 1)[0]
        s = s.rstrip(".")
        return s or None
    return None


def _tg_from_name(name: str | None) -> str | None:
    if not name:
        return None
    m = TG_USERNAME_RE.search(name)
    return m.group(1) if m else None


class AmoSync(SyncSource):
    name = "amo_leads"

    async def run(self, conn: asyncpg.Connection) -> int:
        if not TOKEN or not BASE_URL:
            raise NotImplementedError("AMO_ACCESS_TOKEN / AMO_BASE_URL не заданы")

        base = BASE_URL if BASE_URL.startswith("http") else f"https://{BASE_URL}"
        headers = {"Authorization": f"Bearer {TOKEN}"}

        upserted = 0
        async with httpx.AsyncClient(timeout=60, headers=headers) as client:
            print(f"[{self.name}] prewarming lookups…", flush=True)
            statuses = await self._fetch_pipelines(client, base)
            users = await self._fetch_users(client, base)
            contacts = await self._fetch_contacts(client, base)
            companies = await self._fetch_companies(client, base)
            print(
                f"[{self.name}] lookups ready — "
                f"statuses={len(statuses)} users={len(users)} "
                f"contacts={len(contacts)} companies={len(companies)}",
                flush=True,
            )

            await self._upsert_statuses(conn, statuses)
            await self._upsert_users(conn, users)

            print(f"[{self.name}] syncing leads…", flush=True)
            page = 1
            while page <= MAX_PAGES:
                url = f"{base}/api/v4/leads?limit={PAGE_LIMIT}&page={page}&with=contacts,companies"
                resp = await get_with_retry(client, url)
                if resp.status_code == 204:
                    break  # AMO отдаёт 204 на пустой странице
                resp.raise_for_status()
                data = resp.json()
                leads = ((data.get("_embedded") or {}).get("leads")) or []
                if not leads:
                    break

                rows = [self._to_row(lead, statuses, users, contacts, companies) for lead in leads]
                await self._upsert_leads(conn, rows)
                upserted += len(rows)

                if not ((data.get("_links") or {}).get("next")):
                    break
                page += 1
                await asyncio.sleep(INTER_PAGE_DELAY_SEC)

        return upserted

    # ── Lookup fetchers ───────────────────────────────────────────────────

    async def _fetch_pipelines(
        self, client: httpx.AsyncClient, base: str
    ) -> dict[tuple[int, int], dict[str, Any]]:
        """{(pipeline_id, status_id) → {pipeline_name, status_name, sort, color, is_editable}}."""
        url = f"{base}/api/v4/leads/pipelines"
        resp = await get_with_retry(client, url)
        resp.raise_for_status()
        data = resp.json()
        pipelines = ((data.get("_embedded") or {}).get("pipelines")) or []
        out: dict[tuple[int, int], dict[str, Any]] = {}
        for p in pipelines:
            pid = p.get("id")
            pname = p.get("name")
            statuses = ((p.get("_embedded") or {}).get("statuses")) or []
            for s in statuses:
                sid = s.get("id")
                if pid is None or sid is None:
                    continue
                out[(pid, sid)] = {
                    "pipeline_name": pname,
                    "status_name": s.get("name"),
                    "sort": s.get("sort"),
                    "color": s.get("color"),
                    "is_editable": s.get("is_editable"),
                }
        return out

    async def _fetch_users(
        self, client: httpx.AsyncClient, base: str
    ) -> dict[int, dict[str, Any]]:
        """{user_id → {name, email, role, lang, is_active}}."""
        out: dict[int, dict[str, Any]] = {}
        page = 1
        while page <= MAX_PAGES:
            url = f"{base}/api/v4/users?limit={PAGE_LIMIT}&page={page}&with=role,group"
            resp = await get_with_retry(client, url)
            if resp.status_code == 204:
                break
            resp.raise_for_status()
            data = resp.json()
            users = ((data.get("_embedded") or {}).get("users")) or []
            if not users:
                break
            for u in users:
                uid = u.get("id")
                if uid is None:
                    continue
                rights = u.get("rights") or {}
                # role: первая роль из _embedded, если AMO вернул. Иначе — 'admin'
                # если is_admin, иначе None.
                embedded_roles = ((u.get("_embedded") or {}).get("roles")) or []
                if embedded_roles:
                    role = embedded_roles[0].get("name")
                elif rights.get("is_admin"):
                    role = "admin"
                else:
                    role = None
                out[uid] = {
                    "name": u.get("name"),
                    "email": u.get("email"),
                    "role": role,
                    "lang": u.get("lang"),
                    "is_active": bool(rights.get("is_active", True)),
                }
            if not ((data.get("_links") or {}).get("next")):
                break
            page += 1
            await asyncio.sleep(INTER_PAGE_DELAY_SEC)
        return out

    async def _fetch_contacts(
        self, client: httpx.AsyncClient, base: str
    ) -> dict[int, dict[str, str | None]]:
        """{contact_id → {phone, email, tg_username, name}}. company_name достаётся отдельно."""
        out: dict[int, dict[str, str | None]] = {}
        page = 1
        while page <= MAX_PAGES:
            url = f"{base}/api/v4/contacts?limit={PAGE_LIMIT}&page={page}"
            resp = await get_with_retry(client, url)
            if resp.status_code == 204:
                break
            resp.raise_for_status()
            data = resp.json()
            contacts = ((data.get("_embedded") or {}).get("contacts")) or []
            if not contacts:
                break
            for c in contacts:
                cid = c.get("id")
                if cid is None:
                    continue
                # Имя: сначала пробуем c["name"] (то что менеджер видит в AMO),
                # потом склеиваем first_name + last_name как запасной вариант.
                display_name = (c.get("name") or "").strip() or None
                if not display_name:
                    parts = [p for p in (c.get("first_name"), c.get("last_name")) if p]
                    display_name = " ".join(parts).strip() or None
                out[cid] = {
                    "phone": _cf_by_code(c, "PHONE"),
                    "email": _cf_by_code(c, "EMAIL"),
                    "tg_username": _tg_from_contact(c),
                    "name": display_name,
                }
            if not ((data.get("_links") or {}).get("next")):
                break
            page += 1
            await asyncio.sleep(INTER_PAGE_DELAY_SEC)
        return out

    async def _fetch_companies(
        self, client: httpx.AsyncClient, base: str
    ) -> dict[int, str]:
        """{company_id → name}."""
        out: dict[int, str] = {}
        page = 1
        while page <= MAX_PAGES:
            url = f"{base}/api/v4/companies?limit={PAGE_LIMIT}&page={page}"
            resp = await get_with_retry(client, url)
            if resp.status_code == 204:
                break
            resp.raise_for_status()
            data = resp.json()
            companies = ((data.get("_embedded") or {}).get("companies")) or []
            if not companies:
                break
            for co in companies:
                cid = co.get("id")
                name = co.get("name")
                if cid is not None and name:
                    out[cid] = name
            if not ((data.get("_links") or {}).get("next")):
                break
            page += 1
            await asyncio.sleep(INTER_PAGE_DELAY_SEC)
        return out

    # ── Row builder ───────────────────────────────────────────────────────

    def _to_row(
        self,
        lead: dict[str, Any],
        statuses: dict[tuple[int, int], dict[str, Any]],
        users: dict[int, dict[str, Any]],
        contacts: dict[int, dict[str, str | None]],
        companies: dict[int, str],
    ) -> tuple:
        cf = _cf_map(lead)
        pid = lead.get("pipeline_id")
        sid = lead.get("status_id")
        pipe_row = statuses.get((pid, sid)) if pid is not None and sid is not None else None
        rid = lead.get("responsible_user_id")
        user_row = users.get(rid) if rid is not None else None

        main_contact_id = _main_contact_id(lead)
        contact_row = contacts.get(main_contact_id) if main_contact_id else None

        company_id = _first_company_id(lead)
        company_name = companies.get(company_id) if company_id else None

        # TG-юзер: сначала из контакта, потом fallback — regex на name.
        tg_username = (contact_row or {}).get("tg_username") or _tg_from_name(lead.get("name"))
        website = _extract_website_from_lead(lead)

        # Имя сделки: если AMO дал шаблонное «Сделка #NNN» (менеджер не
        # переименовал), подставляем имя контакта. Так downstream
        # (Google Sheets отчёты, TG бот) вместо ссылки на карточку показывают
        # реальное имя человека.
        raw_deal_name = lead.get("name")
        deal_name: str | None = raw_deal_name
        if raw_deal_name and raw_deal_name.startswith("Сделка #"):
            contact_name = (contact_row or {}).get("name")
            if contact_name:
                deal_name = contact_name

        return (
            lead["id"],
            deal_name,
            sid,
            pipe_row["status_name"] if pipe_row else None,
            pid,
            pipe_row["pipeline_name"] if pipe_row else None,
            lead.get("price"),
            rid,
            user_row["name"] if user_row else None,
            cf.get(YM_FIELD_ID),
            contact_row["phone"] if contact_row else None,
            contact_row["email"] if contact_row else None,
            company_name,
            tg_username,
            website,
            _ts(lead.get("created_at")),
            _ts(lead.get("updated_at")),
            _ts(lead.get("closed_at")),
            json.dumps(lead, ensure_ascii=False),
        )

    # ── Upserts ───────────────────────────────────────────────────────────

    async def _upsert_leads(self, conn: asyncpg.Connection, rows: list[tuple]) -> None:
        # company_name НЕ трогаем в UPDATE если AMO вернул NULL — воркер amo_enrich
        # мог заполнить это поле с сайта; не должны его снести обратно в NULL.
        await conn.executemany(
            """INSERT INTO amo_leads (
                 amo_id, name, status_id, status_name, pipeline_id, pipeline_name,
                 amount, responsible_user_id, responsible_name,
                 ym_client_id, contact_phone, contact_email, company_name,
                 contact_tg_username, company_website,
                 created_at, updated_at, closed_at, raw
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb)
               ON CONFLICT (amo_id) DO UPDATE SET
                 name                = EXCLUDED.name,
                 status_id           = EXCLUDED.status_id,
                 status_name         = EXCLUDED.status_name,
                 pipeline_id         = EXCLUDED.pipeline_id,
                 pipeline_name       = EXCLUDED.pipeline_name,
                 amount              = EXCLUDED.amount,
                 responsible_user_id = EXCLUDED.responsible_user_id,
                 responsible_name    = EXCLUDED.responsible_name,
                 ym_client_id        = EXCLUDED.ym_client_id,
                 contact_phone       = EXCLUDED.contact_phone,
                 contact_email       = EXCLUDED.contact_email,
                 company_name        = COALESCE(EXCLUDED.company_name, amo_leads.company_name),
                 contact_tg_username = EXCLUDED.contact_tg_username,
                 company_website     = EXCLUDED.company_website,
                 updated_at          = EXCLUDED.updated_at,
                 closed_at           = EXCLUDED.closed_at,
                 raw                 = EXCLUDED.raw,
                 synced_at           = now()""",
            rows,
        )

    async def _upsert_statuses(
        self,
        conn: asyncpg.Connection,
        statuses: dict[tuple[int, int], dict[str, Any]],
    ) -> None:
        if not statuses:
            return
        rows = [
            (
                pid,
                sid,
                v["pipeline_name"],
                v["status_name"],
                v["sort"],
                v["color"],
                v["is_editable"],
            )
            for (pid, sid), v in statuses.items()
        ]
        await conn.executemany(
            """INSERT INTO amo_statuses
                 (pipeline_id, status_id, pipeline_name, status_name, sort, color, is_editable)
               VALUES ($1,$2,$3,$4,$5,$6,$7)
               ON CONFLICT (pipeline_id, status_id) DO UPDATE SET
                 pipeline_name = EXCLUDED.pipeline_name,
                 status_name   = EXCLUDED.status_name,
                 sort          = EXCLUDED.sort,
                 color         = EXCLUDED.color,
                 is_editable   = EXCLUDED.is_editable,
                 synced_at     = now()""",
            rows,
        )

    async def _upsert_users(
        self,
        conn: asyncpg.Connection,
        users: dict[int, dict[str, Any]],
    ) -> None:
        if not users:
            return
        rows = [
            (uid, v["name"], v["email"], v.get("role"), v.get("lang"), v.get("is_active"))
            for uid, v in users.items()
        ]
        await conn.executemany(
            """INSERT INTO amo_users (id, name, email, role, lang, is_active)
               VALUES ($1,$2,$3,$4,$5,$6)
               ON CONFLICT (id) DO UPDATE SET
                 name       = EXCLUDED.name,
                 email      = EXCLUDED.email,
                 role       = EXCLUDED.role,
                 lang       = EXCLUDED.lang,
                 is_active  = EXCLUDED.is_active,
                 synced_at  = now()""",
            rows,
        )

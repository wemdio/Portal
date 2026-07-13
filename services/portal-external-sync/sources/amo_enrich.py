"""AMO enrichment: подтягивает company_name с сайта, если его нет в AMO.

Ходит на `amo_leads.company_website` (заполнен на предыдущем шаге amo.py из
custom-поля «Сайт»), достаёт `<title>` или `og:site_name`, чистит от типовых
приставок и пишет в `amo_leads.company_name`.

Работает как отдельный SyncSource — независимая единица логирования в
`external_sync_runs`. Не блокирует основной sync: если сайт лежит / отдаёт
странный html / таймаутит — просто помечаем `company_name_fetched_at = now()`
и идём дальше (чтобы не долбить его каждую ночь).

Дедуп по `company_name_fetched_at`: не переспрашиваем сайт, если company_name
уже заполнен ИЛИ пробовали за последние 30 дней. Cap `MAX_LEADS_PER_RUN` —
сколько сделок обрабатываем за один ночной прогон (защита от медленных сайтов).
"""
from __future__ import annotations

import asyncio
import os
import re
from typing import Any

import asyncpg
import httpx

from .base import SyncSource

TIMEOUT_SEC = float(os.environ.get("AMO_ENRICH_TIMEOUT_SEC", "10"))
MAX_LEADS_PER_RUN = int(os.environ.get("AMO_ENRICH_MAX_PER_RUN", "500"))
DELAY_SEC = float(os.environ.get("AMO_ENRICH_DELAY_SEC", "0.1"))
STALE_DAYS = int(os.environ.get("AMO_ENRICH_STALE_DAYS", "30"))

# Достаём name из <title> или из <meta property="og:site_name" content="...">.
TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
OG_SITE_NAME_RE = re.compile(
    r'<meta\s+[^>]*property=["\']og:site_name["\'][^>]*content=["\']([^"\']+)["\']',
    re.IGNORECASE,
)
OG_TITLE_RE = re.compile(
    r'<meta\s+[^>]*property=["\']og:title["\'][^>]*content=["\']([^"\']+)["\']',
    re.IGNORECASE,
)

# Отсекаем всё после первого разделителя — типовые «Company | Slogan» / «Company — About».
SEPARATOR_RE = re.compile(r"\s*[\|\-—–:]\s+.*$")

USER_AGENT = (
    "Mozilla/5.0 (compatible; PolzaAgency-Portal/1.0; "
    "+https://polzaagency.ru/portal-bot)"
)


class AmoCompanyEnrichSync(SyncSource):
    name = "amo_enrich"

    async def run(self, conn: asyncpg.Connection) -> int:
        rows = await conn.fetch(
            f"""
            SELECT id, company_website
              FROM amo_leads
             WHERE company_name IS NULL
               AND company_website IS NOT NULL
               AND (company_name_fetched_at IS NULL
                    OR company_name_fetched_at < now() - interval '{STALE_DAYS} days')
             ORDER BY updated_at DESC NULLS LAST
             LIMIT $1
            """,
            MAX_LEADS_PER_RUN,
        )

        if not rows:
            return 0

        enriched = 0
        headers = {"User-Agent": USER_AGENT}
        async with httpx.AsyncClient(
            timeout=TIMEOUT_SEC, headers=headers, follow_redirects=True
        ) as client:
            for row in rows:
                url = self._build_url(row["company_website"])
                if not url:
                    await conn.execute(
                        "UPDATE amo_leads SET company_name_fetched_at = now() WHERE id = $1",
                        row["id"],
                    )
                    continue
                name: str | None = None
                try:
                    name = await self._fetch_company_name(client, url)
                except Exception as e:
                    # Всё, что упало — логируем один раз, идём дальше.
                    print(f"[{self.name}] fetch fail {url}: {e}", flush=True)

                if name:
                    await conn.execute(
                        """UPDATE amo_leads
                              SET company_name = $1,
                                  company_name_fetched_at = now()
                            WHERE id = $2""",
                        name,
                        row["id"],
                    )
                    enriched += 1
                else:
                    await conn.execute(
                        "UPDATE amo_leads SET company_name_fetched_at = now() WHERE id = $1",
                        row["id"],
                    )

                await asyncio.sleep(DELAY_SEC)

        return enriched

    def _build_url(self, host: str | None) -> str | None:
        if not host:
            return None
        h = host.strip().lower()
        if not h or "." not in h:
            return None
        # host уже нормализован в amo.py (без протокола/www/пути), но подстрахуемся.
        h = re.sub(r"^https?://", "", h)
        h = re.sub(r"^www\.", "", h)
        h = h.split("/", 1)[0]
        if not h or " " in h:
            return None
        return f"https://{h}/"

    async def _fetch_company_name(
        self, client: httpx.AsyncClient, url: str
    ) -> str | None:
        resp = await client.get(url)
        if resp.status_code >= 400:
            return None
        # Ограничиваем чтение первыми ~200KB — заголовки/мета обычно в начале.
        html = resp.text[:200_000]

        for regex in (OG_SITE_NAME_RE, OG_TITLE_RE, TITLE_RE):
            m = regex.search(html)
            if not m:
                continue
            raw = self._clean_title(m.group(1))
            if raw:
                return raw
        return None

    def _clean_title(self, s: str) -> str | None:
        if not s:
            return None
        s = s.strip()
        # HTML entities минимально
        s = s.replace("&amp;", "&").replace("&#39;", "'").replace("&quot;", '"')
        s = re.sub(r"\s+", " ", s)
        # Обрезаем всё после « | Слоган» / « — Про нас».
        s = SEPARATOR_RE.sub("", s).strip()
        # Хвост в скобках вроде "(официальный сайт)" тоже не нужен.
        s = re.sub(r"\s*\([^)]*\)\s*$", "", s).strip()
        if not s or len(s) > 200:
            return s[:200] if s else None
        return s

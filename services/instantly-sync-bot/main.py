"""
PolzaInstantlySync Bot

Периодически синхронизирует каталог кампаний Instantly → Supabase (instantly_campaign_catalog).
Расписание: каждый час (настраивается через INSTANTLY_SYNC_INTERVAL_SEC).

Статистика в Telegram после каждой синхронизации:
  — сколько кампаний добавлено в БД
  — сколько удалено (пропали из Instantly)
  — сколько обновлено
  — сколько ошибок / ретраев было

Уведомление отправляется только при изменениях, ошибках или ручном запуске.

Команды:
  /sync   — запустить синхронизацию прямо сейчас
  /last   — результат последней синхронизации
  /help   — справка

Переменные окружения (обязательные):
  POLZA_INSTANTLY_SYNC_BOT_API_KEY   — токен этого бота
  INSTANTLY_API_KEY или INSTANTLY_PORTAL_API_KEY — ключ Instantly
  INSTANTLY_DATABASE_URL              — PostgreSQL connection string (новая Instantly-БД)
  INSTANTLY_SYNC_BOT_CHAT_ID или TELEGRAM_HEALTH_CHAT_ID — чат для отчётов
"""
from __future__ import annotations

import asyncio
import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from collections.abc import AsyncIterator
from typing import Any
from urllib.parse import parse_qs, urlparse

try:
    from dotenv import load_dotenv
    _env_path = Path(__file__).resolve().parent.parent.parent / ".env"
    if _env_path.exists():
        load_dotenv(_env_path)
except ImportError:
    pass

import asyncpg
import httpx
from apscheduler.schedulers.asyncio import AsyncIOScheduler

# ── Config ───────────────────────────────────────────────────────────────────

BOT_TOKEN: str = os.environ.get("POLZA_INSTANTLY_SYNC_BOT_API_KEY", "")
CHAT_ID: str = (
    os.environ.get("INSTANTLY_SYNC_BOT_CHAT_ID")
    or os.environ.get("TELEGRAM_HEALTH_CHAT_ID")
    or ""
)
INSTANTLY_API_KEY: str = (
    os.environ.get("INSTANTLY_API_KEY")
    or os.environ.get("INSTANTLY_PORTAL_API_KEY")
    or ""
).strip()
DATABASE_URL: str = (
    os.environ.get("INSTANTLY_DATABASE_URL")
    or os.environ.get("DATABASE_URL")
    or os.environ.get("SUPABASE_DB_URL")
    or ""
)

SYNC_INTERVAL_SEC: int = int(os.environ.get("INSTANTLY_SYNC_INTERVAL_SEC", str(60 * 60)))  # 1 hour
MIN_SYNC_INTERVAL_SEC = 60 * 60
INSTANTLY_BASE = "https://api.instantly.ai/api/v2"
PAGE_LIMIT = 100
MAX_PAGES = 200
NAME_MAX_LEN = 2000

HTTP_TIMEOUT: int = int(os.environ.get("INSTANTLY_SYNC_HTTP_TIMEOUT_SEC", "30"))
RETRY_ATTEMPTS: int = int(os.environ.get("INSTANTLY_SYNC_RETRY_ATTEMPTS", "3"))
ANALYTICS_FALLBACK_CONCURRENCY: int = int(
    os.environ.get("INSTANTLY_ANALYTICS_FALLBACK_CONCURRENCY", "8")
)

LEADS_PAGE_LIMIT = int(os.environ.get("INSTANTLY_LEADS_PAGE_LIMIT", "100"))
LEADS_CONCURRENCY = int(os.environ.get("INSTANTLY_LEADS_CONCURRENCY", "2"))
LEADS_UPSERT_BATCH = 500
MAX_LEADS_PAGES = 5000
LEADS_DB_POOL_MIN = 2
LEADS_DB_POOL_MAX = LEADS_CONCURRENCY + 3
LEADS_HTTP_TIMEOUT: int = int(os.environ.get("INSTANTLY_LEADS_HTTP_TIMEOUT_SEC", "120"))
LEADS_RETRY_ATTEMPTS: int = int(os.environ.get("INSTANTLY_LEADS_RETRY_ATTEMPTS", "5"))
LEADS_RETRY_BASE_DELAY_SEC: float = float(os.environ.get("INSTANTLY_LEADS_RETRY_BASE_DELAY_SEC", "3"))
LEADS_RETRY_5XX_MULTIPLIER: float = float(
    os.environ.get("INSTANTLY_LEADS_RETRY_5XX_MULTIPLIER", "2.0")
)
LEADS_INTER_PAGE_DELAY_SEC: float = float(
    os.environ.get("INSTANTLY_LEADS_INTER_PAGE_DELAY_SEC", "0.5")
)
LEADS_FLUSH_THRESHOLD = int(os.environ.get("INSTANTLY_LEADS_FLUSH_THRESHOLD", "5000"))
LEADS_RPS_LIMIT: float = float(os.environ.get("INSTANTLY_LEADS_RPS_LIMIT", "3.0"))

def _resolve_db_ssl_mode(database_url: str) -> bool | str:
    """Resolve SSL mode from env/query to avoid forcing SSL on self-hosted PG."""
    ssl_mode = (
        os.environ.get("INSTANTLY_DB_SSLMODE")
        or os.environ.get("PGSSLMODE")
        or parse_qs(urlparse(database_url).query).get("sslmode", [""])[0]
    ).strip().lower()
    if ssl_mode in {"disable", "allow", "prefer"}:
        return False
    return "require"


_CONNECT_KWARGS: dict[str, bool | str | int] = {
    "statement_cache_size": 0,
    "ssl": _resolve_db_ssl_mode(DATABASE_URL),
}

# ── Rate limiter ──────────────────────────────────────────────────────────────

class _TokenBucket:
    """Simple token-bucket rate limiter shared across all concurrent workers."""

    def __init__(self, rate: float, burst: int = 1):
        self._rate = rate
        self._burst = burst
        self._tokens = float(burst)
        self._last: float | None = None
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        async with self._lock:
            loop = asyncio.get_running_loop()
            now = loop.time()
            if self._last is None:
                self._last = now
            self._tokens = min(self._burst, self._tokens + (now - self._last) * self._rate)
            self._last = now
            if self._tokens < 1:
                wait = (1 - self._tokens) / self._rate
                await asyncio.sleep(wait)
                self._tokens = 0
            else:
                self._tokens -= 1

# ── State ─────────────────────────────────────────────────────────────────────

_last_sync_result: dict | None = None
_sync_lock = asyncio.Lock()


# ── Helpers ───────────────────────────────────────────────────────────────────

def _parse_ts(val: Any) -> datetime | None:
    """Parse an ISO-8601 string into a timezone-aware datetime, or return None."""
    if isinstance(val, datetime):
        return val
    if not isinstance(val, str) or not val.strip():
        return None
    try:
        dt = datetime.fromisoformat(val.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (ValueError, TypeError):
        return None


def _now_msk() -> str:
    msk = timezone(timedelta(hours=3))
    return datetime.now(msk).strftime("%d.%m.%Y %H:%M MSK")


async def _retry(fn, retries: int = RETRY_ATTEMPTS, base_delay: float = 5.0) -> Any:
    """Retry an async callable with exponential backoff (5s → 15s → 45s)."""
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            return await fn()
        except Exception as e:
            last_err = e
            if attempt < retries - 1:
                delay = base_delay * (3 ** attempt)
                print(
                    f"[sync] attempt {attempt + 1}/{retries} failed: {e!r}. "
                    f"Retry in {delay:.0f}s…"
                )
                await asyncio.sleep(delay)
    raise last_err  # type: ignore[misc]


# ── Telegram ──────────────────────────────────────────────────────────────────

async def send_telegram(text: str, parse_mode: str = "HTML") -> bool:
    if not BOT_TOKEN or not CHAT_ID:
        return False
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": CHAT_ID,
        "text": text,
        "parse_mode": parse_mode,
        "disable_web_page_preview": True,
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(url, json=payload)
            if not r.is_success:
                print(f"[sync] TG error {r.status_code}: {r.text[:200]}")
            return r.is_success
    except Exception as e:
        print(f"[sync] TG send error: {e}")
        return False


async def poll_telegram_commands() -> None:
    """Long-poll Telegram for /sync, /last, /help commands."""
    if not BOT_TOKEN or not CHAT_ID:
        return
    chat_id_str = str(CHAT_ID).strip()
    last_update_id = 0
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/getUpdates"
    while True:
        try:
            async with httpx.AsyncClient(timeout=35) as client:
                r = await client.get(url, params={"offset": last_update_id + 1, "timeout": 30})
            if not r.is_success:
                await asyncio.sleep(5)
                continue
            data = r.json()
            for upd in data.get("result", []):
                last_update_id = max(last_update_id, upd.get("update_id", 0))
                msg = upd.get("message") or {}
                if str(msg.get("chat", {}).get("id")) != chat_id_str:
                    continue
                raw_text = (msg.get("text") or "").strip()
                cmd = raw_text.lower().split()[0] if raw_text else ""
                # Strip bot mention: /sync@BotName → /sync
                cmd = cmd.split("@")[0]
                if cmd in ("/sync", "/синхронизация"):
                    asyncio.create_task(_run_sync_and_report(manual=True))
                elif cmd in ("/last", "/последняя"):
                    await _send_last_result()
                elif cmd in ("/help", "/помощь", "/start", "/старт"):
                    await send_telegram(
                        "🔄 <b>Instantly Sync Bot</b>\n\n"
                        "/sync — запустить синхронизацию прямо сейчас\n"
                        "/last — результат последней синхронизации\n"
                        "/help — эта справка\n\n"
                        f"⏱ Автосинхронизация: каждый час"
                    )
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"[sync] poll_telegram error: {e}")
            await asyncio.sleep(5)


async def _send_last_result() -> None:
    if not _last_sync_result:
        await send_telegram("ℹ️ Синхронизация ещё не запускалась.")
        return
    await send_telegram(_format_sync_result(_last_sync_result))


# ── Instantly API ─────────────────────────────────────────────────────────────

def _extract_items(data: Any) -> list[dict]:
    """Extract campaign list from various Instantly API response shapes."""
    if isinstance(data, list):
        return data
    if not isinstance(data, dict):
        return []
    for key in ("items", "campaigns", "data"):
        if isinstance(data.get(key), list):
            return data[key]
    body = data.get("body")
    if isinstance(body, list):
        return body
    if isinstance(body, dict) and isinstance(body.get("campaigns"), list):
        return body["campaigns"]
    return []


async def _fetch_campaigns_page(
    client: httpx.AsyncClient,
    starting_after: str | None,
    error_count_ref: list[int],
) -> dict:
    """Fetch one page from Instantly with retries. Increments error_count_ref on each failed attempt."""
    url = f"{INSTANTLY_BASE}/campaigns"
    params: dict[str, str] = {"limit": str(PAGE_LIMIT)}
    if starting_after:
        params["starting_after"] = starting_after
    headers = {"Authorization": f"Bearer {INSTANTLY_API_KEY}"}

    last_err: Exception | None = None
    for attempt in range(RETRY_ATTEMPTS):
        try:
            r = await client.get(url, params=params, headers=headers, timeout=HTTP_TIMEOUT)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            last_err = e
            error_count_ref[0] += 1
            if attempt < RETRY_ATTEMPTS - 1:
                delay = 5.0 * (3 ** attempt)
                print(
                    f"[sync] Instantly page fetch attempt {attempt + 1}/{RETRY_ATTEMPTS} "
                    f"failed: {e!r}. Retry in {delay:.0f}s…"
                )
                await asyncio.sleep(delay)

    raise last_err  # type: ignore[misc]


async def fetch_all_instantly_campaigns() -> tuple[list[dict], int]:
    """
    Paginate Instantly /campaigns, return (all_items, error_count).
    error_count counts retried (but eventually successful) page fetches.
    """
    all_campaigns: list[dict] = []
    starting_after: str | None = None
    seen_cursors: set[str] = set()
    pages = 0
    error_count = [0]

    async with httpx.AsyncClient() as client:
        while True:
            cursor_key = starting_after or "__first__"
            if cursor_key in seen_cursors:
                print(f"[sync] WARNING: pagination loop detected at cursor {cursor_key!r}")
                break
            seen_cursors.add(cursor_key)
            pages += 1
            if pages > MAX_PAGES:
                print(f"[sync] WARNING: reached page cap ({MAX_PAGES})")
                break

            data = await _fetch_campaigns_page(client, starting_after, error_count)
            items = _extract_items(data)
            if items:
                all_campaigns.extend(items)

            next_cursor = None
            if isinstance(data, dict):
                nsc = data.get("next_starting_after")
                if isinstance(nsc, str) and nsc:
                    next_cursor = nsc

            if not next_cursor:
                if len(items) < PAGE_LIMIT:
                    break
                # fallback: use last item id as cursor
                last_id = items[-1].get("id") if items else None
                if not last_id:
                    break
                next_cursor = last_id

            starting_after = next_cursor

    return all_campaigns, error_count[0]


# ── Instantly Analytics API ──────────────────────────────────────────────────

async def fetch_campaign_analytics(
    campaign_ids: list[str] | None = None,
) -> list[dict]:
    """
    Fetch analytics for all campaigns from Instantly API.

    Strategy:
      1. Try the bulk endpoint  GET /campaigns/analytics  (cheap, one round-trip).
      2. If bulk fails (5xx) OR returns an empty list, AND `campaign_ids` is
         provided, fall back to per-id requests issued in parallel under a
         semaphore (concurrency = ANALYTICS_FALLBACK_CONCURRENCY, default 8).
         Per-id failures are logged and skipped — we return whatever loaded
         successfully so the cache still gets refreshed for healthy campaigns.

    Why per-id fallback exists: Instantly's bulk endpoint started returning
    sporadic 500 ("Unable to count leads") on workspaces with ~1700 campaigns
    around April 2026, leaving `instantly_campaign_catalog.analytics_synced_at`
    stuck. Per-id requests are cheap (~400ms each) because they only count
    leads for one campaign at a time.
    """
    ANALYTICS_TIMEOUT = max(HTTP_TIMEOUT, 120)
    headers = {"Authorization": f"Bearer {INSTANTLY_API_KEY}"}

    def _parse_response(data: Any) -> list[dict]:
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            for key in ("data", "items", "campaigns"):
                if isinstance(data.get(key), list):
                    return data[key]
        return []

    async def _bulk_fetch() -> list[dict] | None:
        """Returns the bulk array on success (may be empty), or None on every-attempt failure."""
        last_err: Exception | None = None
        for attempt in range(RETRY_ATTEMPTS):
            try:
                async with httpx.AsyncClient(timeout=ANALYTICS_TIMEOUT) as client:
                    r = await client.get(
                        f"{INSTANTLY_BASE}/campaigns/analytics",
                        headers=headers,
                    )
                    r.raise_for_status()
                    return _parse_response(r.json())
            except Exception as e:
                last_err = e
                if attempt < RETRY_ATTEMPTS - 1:
                    delay = 5.0 * (2 ** attempt)
                    print(
                        f"[sync] Analytics bulk fetch attempt {attempt + 1}/{RETRY_ATTEMPTS} "
                        f"failed: {e!r}. Retry in {delay:.0f}s…"
                    )
                    await asyncio.sleep(delay)
        print(f"[sync] Analytics bulk fetch failed after {RETRY_ATTEMPTS} attempts: {last_err!r}")
        return None

    async def _fetch_one(
        client: httpx.AsyncClient, sem: asyncio.Semaphore, cid: str
    ) -> dict | None:
        async with sem:
            try:
                r = await client.get(
                    f"{INSTANTLY_BASE}/campaigns/analytics",
                    params={"id": cid},
                    headers=headers,
                )
                r.raise_for_status()
                items = _parse_response(r.json())
                if items:
                    return items[0]
            except Exception as e:
                print(f"[sync] Analytics per-id fetch failed for {cid}: {e!r}")
            return None

    async def _per_id_fetch(ids: list[str]) -> list[dict]:
        sem = asyncio.Semaphore(ANALYTICS_FALLBACK_CONCURRENCY)
        async with httpx.AsyncClient(timeout=ANALYTICS_TIMEOUT) as client:
            results = await asyncio.gather(
                *(_fetch_one(client, sem, cid) for cid in ids),
                return_exceptions=False,
            )
        return [r for r in results if r is not None]

    bulk_result = await _bulk_fetch()
    if bulk_result:
        print(f"[sync] Analytics bulk fetch returned {len(bulk_result)} campaigns")
        return bulk_result

    if not campaign_ids:
        return []

    reason = "empty body" if bulk_result == [] else "bulk failed"
    print(
        f"[sync] {reason}; falling back to per-id analytics fetch for "
        f"{len(campaign_ids)} campaigns (concurrency={ANALYTICS_FALLBACK_CONCURRENCY})…"
    )
    per_id_result = await _per_id_fetch(campaign_ids)
    print(
        f"[sync] Analytics per-id fetch returned {len(per_id_result)}/"
        f"{len(campaign_ids)} campaigns"
    )
    return per_id_result


# ── Database ──────────────────────────────────────────────────────────────────

async def _db_count(conn) -> int:
    return int(await conn.fetchval("SELECT COUNT(*)::int FROM public.instantly_campaign_catalog") or 0)


async def _upsert_batch(conn, batch: list[dict]) -> None:
    if not batch:
        return
    await conn.executemany(
        """
        INSERT INTO public.instantly_campaign_catalog
            (id, name, status, timestamp_created, timestamp_updated, synced_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (id) DO UPDATE SET
            name               = EXCLUDED.name,
            status             = EXCLUDED.status,
            timestamp_created  = EXCLUDED.timestamp_created,
            timestamp_updated  = EXCLUDED.timestamp_updated,
            synced_at          = EXCLUDED.synced_at
        """,
        [
            (
                c["id"],
                c["name"],
                c["status"],
                c["timestamp_created"],
                c["timestamp_updated"],
                c["synced_at"],
            )
            for c in batch
        ],
    )


async def sync_to_db(campaigns: list[dict]) -> dict[str, int]:
    """
    Upsert all fetched campaigns, delete rows absent from this run.

    Returns: before, after, added, removed, updated.
    """
    sync_marker = datetime.now(timezone.utc)

    rows: list[dict] = []
    for c in campaigns:
        cid = c.get("id") or ""
        if not cid:
            continue
        rows.append({
            "id": cid,
            "name": str(c.get("name") or "")[:NAME_MAX_LEN],
            "status": c.get("status") if isinstance(c.get("status"), int) else None,
            "timestamp_created": _parse_ts(c.get("timestamp_created")),
            "timestamp_updated": _parse_ts(c.get("timestamp_updated")),
            "synced_at": sync_marker,
        })

    async def _do() -> dict[str, int]:
        conn = await asyncpg.connect(DATABASE_URL, **_CONNECT_KWARGS)
        try:
            before = await _db_count(conn)

            BATCH_SIZE = 200
            for i in range(0, len(rows), BATCH_SIZE):
                await _upsert_batch(conn, rows[i : i + BATCH_SIZE])

            after_upsert = await _db_count(conn)

            deleted_result = await conn.execute(
                "DELETE FROM public.instantly_campaign_catalog WHERE synced_at < $1",
                sync_marker,
            )
            # asyncpg returns "DELETE N"
            removed = int(deleted_result.split()[-1]) if deleted_result else 0

            after = await _db_count(conn)

            added = max(after_upsert - before, 0)
            updated = max(len(rows) - added, 0)

            return {
                "before": before,
                "after": after,
                "fetched": len(rows),
                "added": added,
                "removed": removed,
                "updated": updated,
            }
        finally:
            await conn.close()

    return await _retry(_do, base_delay=2.0)  # type: ignore[return-value]


def _safe_int(val: Any) -> int | None:
    if isinstance(val, int):
        return val
    if isinstance(val, (float, str)):
        try:
            return int(val)
        except (ValueError, TypeError):
            return None
    return None


async def sync_analytics_to_db(analytics: list[dict]) -> int:
    """
    Update analytics columns in instantly_campaign_catalog for campaigns
    returned by the /campaigns/analytics endpoint.
    Returns: number of rows updated.
    """
    rows: list[tuple] = []
    sync_marker = datetime.now(timezone.utc)
    for a in analytics:
        cid = a.get("campaign_id") or ""
        if not cid:
            continue
        rows.append((
            cid,
            _safe_int(a.get("emails_sent_count")),
            _safe_int(a.get("open_count")),
            _safe_int(a.get("reply_count")),
            _safe_int(a.get("new_leads_contacted_count")),
            _safe_int(a.get("bounced_count")),
            _safe_int(a.get("unsubscribed_count")),
            _safe_int(a.get("leads_count")),
            sync_marker,
        ))

    if not rows:
        return 0

    async def _do() -> int:
        conn = await asyncpg.connect(DATABASE_URL, **_CONNECT_KWARGS)
        try:
            BATCH = 200
            for i in range(0, len(rows), BATCH):
                await conn.executemany(
                    """
                    UPDATE public.instantly_campaign_catalog SET
                        emails_sent_count          = $2,
                        open_count                 = $3,
                        reply_count                = $4,
                        new_leads_contacted_count  = $5,
                        bounced_count              = $6,
                        unsubscribed_count         = $7,
                        leads_count                = $8,
                        analytics_synced_at        = $9
                    WHERE id = $1::uuid
                    """,
                    rows[i : i + BATCH],
                )
            return len(rows)
        finally:
            await conn.close()

    return await _retry(_do, base_delay=2.0)  # type: ignore[return-value]


# ── Client leads sync ─────────────────────────────────────────────────────────

def _format_leads_sync_error(exc: BaseException) -> str:
    """Non-empty diagnostic for logs / Telegram (some httpx errors stringify to '')."""
    if isinstance(exc, httpx.HTTPStatusError):
        r = exc.response
        snippet = (r.text or "").strip().replace("\n", " ")[:240]
        base = str(exc).strip() or f"HTTP {r.status_code} for {r.request.method} {r.url}"
        return f"{base} | body: {snippet!r}" if snippet else base
    if isinstance(exc, httpx.RequestError):
        msg = str(exc).strip() or exc.__class__.__name__
        return f"{exc.__class__.__name__}: {msg}"
    msg = str(exc).strip()
    return f"{exc.__class__.__name__}: {msg}" if msg else repr(exc)


def _leads_retry_delay(attempt: int, *, status_code: int | None) -> float:
    base = LEADS_RETRY_BASE_DELAY_SEC * (2**attempt)
    if status_code is not None and status_code in (502,503,504,429):
        base *= LEADS_RETRY_5XX_MULTIPLIER
    return base


async def _fetch_leads_page(
    client: httpx.AsyncClient,
    campaign_id: str,
    starting_after: str | None,
    rate_limiter: _TokenBucket | None = None,
) -> dict:
    """Fetch one page of leads for a campaign from Instantly."""
    url = f"{INSTANTLY_BASE}/leads/list"
    headers = {"Authorization": f"Bearer {INSTANTLY_API_KEY}"}
    body: dict[str, Any] = {"campaign": campaign_id, "limit": LEADS_PAGE_LIMIT}
    if starting_after:
        body["starting_after"] = starting_after

    last_err: BaseException | None = None
    for attempt in range(LEADS_RETRY_ATTEMPTS):
        if rate_limiter is not None:
            await rate_limiter.acquire()
        try:
            r = await client.post(url, json=body, headers=headers)
            r.raise_for_status()
            return r.json()
        except httpx.HTTPStatusError as e:
            last_err = e
            code = e.response.status_code if e.response is not None else None
            if code is not None and code < 500 and code != 429:
                raise
            if attempt < LEADS_RETRY_ATTEMPTS - 1:
                delay = _leads_retry_delay(attempt, status_code=code)
                print(
                    f"[leads-sync] campaign {campaign_id[:12]}: attempt "
                    f"{attempt + 1}/{LEADS_RETRY_ATTEMPTS} failed: {_format_leads_sync_error(e)}. "
                    f"Retry in {delay:.1f}s…"
                )
                await asyncio.sleep(delay)
        except (httpx.ReadTimeout, httpx.ConnectTimeout, httpx.PoolTimeout) as e:
            last_err = e
            if attempt < LEADS_RETRY_ATTEMPTS - 1:
                delay = _leads_retry_delay(attempt, status_code=None) * 1.5
                print(
                    f"[leads-sync] campaign {campaign_id[:12]}: attempt "
                    f"{attempt + 1}/{LEADS_RETRY_ATTEMPTS} timeout. "
                    f"Retry in {delay:.1f}s…"
                )
                await asyncio.sleep(delay)
        except Exception as e:
            last_err = e
            if attempt < LEADS_RETRY_ATTEMPTS - 1:
                delay = _leads_retry_delay(attempt, status_code=None)
                print(
                    f"[leads-sync] campaign {campaign_id[:12]}: attempt "
                    f"{attempt + 1}/{LEADS_RETRY_ATTEMPTS} failed: {_format_leads_sync_error(e)}. "
                    f"Retry in {delay:.1f}s…"
                )
                await asyncio.sleep(delay)
    assert last_err is not None
    raise last_err


async def _iter_leads_pages(
    client: httpx.AsyncClient,
    campaign_id: str,
    rate_limiter: _TokenBucket | None = None,
) -> AsyncIterator[list[dict]]:
    """Yield one page of leads at a time — keeps memory flat for huge campaigns."""
    after: str | None = None
    pages = 0
    seen_cursors: set[str] = set()

    while True:
        cursor_key = after or "__first__"
        if cursor_key in seen_cursors:
            print(f"[leads-sync] WARNING: pagination loop at cursor {cursor_key!r}, stopping")
            break
        seen_cursors.add(cursor_key)

        pages += 1
        if pages > MAX_LEADS_PAGES:
            print(f"[leads-sync] WARNING: reached page cap ({MAX_LEADS_PAGES}) for {campaign_id[:12]}")
            break

        data = await _fetch_leads_page(client, campaign_id, after, rate_limiter)
        items = data.get("items", []) if isinstance(data, dict) else []
        if items:
            yield items

        nsa = data.get("next_starting_after") if isinstance(data, dict) else None
        after = nsa if isinstance(nsa, str) and nsa else None
        if not after:
            break

        if LEADS_INTER_PAGE_DELAY_SEC > 0:
            await asyncio.sleep(LEADS_INTER_PAGE_DELAY_SEC)


async def _update_leads_synced_at(conn, campaign_id: str, user_ids: list[str]) -> None:
    now = datetime.now(timezone.utc)
    await conn.execute(
        "UPDATE public.client_instantly_access SET leads_synced_at = $1 "
        "WHERE resource_type = 'campaign' AND resource_id = $2 "
        "AND client_user_id = ANY($3::uuid[])",
        now,
        campaign_id,
        user_ids,
    )


_LEADS_UPSERT_SQL = """
    INSERT INTO public.client_campaign_leads
        (client_user_id, campaign_id, email,
         first_name, last_name, company_name,
         website, linkedin_url, synced_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (client_user_id, campaign_id, email) DO UPDATE SET
        first_name   = EXCLUDED.first_name,
        last_name    = EXCLUDED.last_name,
        company_name = EXCLUDED.company_name,
        website      = EXCLUDED.website,
        linkedin_url = EXCLUDED.linkedin_url,
        synced_at    = EXCLUDED.synced_at
"""


async def _flush_leads_buffer(
    pool: asyncpg.Pool,
    campaign_id: str,
    user_ids: list[str],
    buffer: list[dict],
    now: datetime,
) -> None:
    """Write buffered leads to DB in sub-batches, releasing connection promptly."""
    async with pool.acquire() as conn:
        for uid in user_ids:
            rows = [
                (
                    uid, campaign_id, l.get("email", ""),
                    l.get("first_name"), l.get("last_name"),
                    l.get("company_name"), l.get("website"),
                    l.get("linkedin_url"), now,
                )
                for l in buffer if l.get("email")
            ]
            for i in range(0, len(rows), LEADS_UPSERT_BATCH):
                await conn.executemany(
                    _LEADS_UPSERT_SQL, rows[i : i + LEADS_UPSERT_BATCH],
                )


async def _sync_single_campaign(
    pool: asyncpg.Pool,
    http_client: httpx.AsyncClient,
    campaign_id: str,
    user_ids: list[str],
    progress: dict[str, int],
    rate_limiter: _TokenBucket | None = None,
) -> tuple[int, int]:
    """Sync leads for one campaign. Returns (leads_count, error_count)."""
    try:
        campaign_leads = 0
        now = datetime.now(timezone.utc)
        buffer: list[dict] = []

        async for page_items in _iter_leads_pages(http_client, campaign_id, rate_limiter):
            buffer.extend(page_items)
            campaign_leads += len(page_items)

            if len(buffer) >= LEADS_FLUSH_THRESHOLD:
                await _flush_leads_buffer(pool, campaign_id, user_ids, buffer, now)
                print(
                    f"[leads-sync] campaign {campaign_id} — "
                    f"flushed {campaign_leads} leads so far"
                )
                buffer = []

        if buffer:
            await _flush_leads_buffer(pool, campaign_id, user_ids, buffer, now)

        async with pool.acquire() as conn:
            await _update_leads_synced_at(conn, campaign_id, user_ids)

        if campaign_leads:
            print(
                f"[leads-sync] campaign {campaign_id} — {campaign_leads} leads "
                f"for {len(user_ids)} user(s)"
            )
        return campaign_leads, 0

    except Exception as e:
        print(
            f"[leads-sync] ERROR campaign {campaign_id}: "
            f"{_format_leads_sync_error(e)}"
        )
        return 0, 1
    finally:
        progress["done"] += 1
        done, total = progress["done"], progress["total"]
        if done % 5 == 0 or done == total:
            print(f"[leads-sync] progress: {done}/{total} campaigns completed")


async def sync_client_leads() -> dict[str, int]:
    """
    Sync leads from Instantly API into client_campaign_leads for all client users.
    Campaigns are processed in parallel (up to LEADS_CONCURRENCY at a time)
    using a DB connection pool and shared HTTP client.

    Leads are fetched in pages of LEADS_PAGE_LIMIT, buffered up to
    LEADS_FLUSH_THRESHOLD, then flushed to DB in sub-batches of
    LEADS_UPSERT_BATCH.  DB connections are held only during flushes.

    Resource budget (2xXeon E5-2670 / 64GB):
      DB pool: max 5 conns  ← well under 95% of pgbouncer limit (57 of 60)
      HTTP:    max 4 conns  ← 2 active + 2 keepalive buffer
      Rate:    ~3 RPS global limit across all workers
      Memory:  ~2 × 5000 leads × ~2KB ≈ 20MB peak — acceptable
    """
    pool = await asyncpg.create_pool(
        DATABASE_URL,
        min_size=LEADS_DB_POOL_MIN,
        max_size=LEADS_DB_POOL_MAX,
        **_CONNECT_KWARGS,
    )
    try:
        async with pool.acquire() as conn:
            access_rows = await conn.fetch(
                "SELECT client_user_id, resource_id FROM public.client_instantly_access "
                "WHERE resource_type = 'campaign'"
            )

        if not access_rows:
            print("[leads-sync] no access rows — skipping")
            return {"campaigns": 0, "leads": 0}

        campaign_users: dict[str, list[str]] = {}
        for row in access_rows:
            cid = str(row["resource_id"])
            uid = str(row["client_user_id"])
            campaign_users.setdefault(cid, []).append(uid)

        print(
            f"[leads-sync] {len(campaign_users)} campaigns for "
            f"{len(access_rows)} access rows (concurrency={LEADS_CONCURRENCY})"
        )

        semaphore = asyncio.Semaphore(LEADS_CONCURRENCY)
        progress: dict[str, int] = {"done": 0, "total": len(campaign_users)}

        _timeout = httpx.Timeout(
            connect=15.0,
            read=float(LEADS_HTTP_TIMEOUT),
            write=30.0,
            pool=30.0,
        )
        _limits = httpx.Limits(
            max_connections=LEADS_CONCURRENCY + 2,
            max_keepalive_connections=LEADS_CONCURRENCY + 2,
        )
        rate_limiter = _TokenBucket(rate=LEADS_RPS_LIMIT, burst=max(1, int(LEADS_RPS_LIMIT)))

        async with httpx.AsyncClient(timeout=_timeout, limits=_limits) as http_client:

            async def _bounded(cid: str, uids: list[str]) -> tuple[int, int]:
                async with semaphore:
                    return await _sync_single_campaign(
                        pool, http_client, cid, uids, progress, rate_limiter,
                    )

            results = await asyncio.gather(
                *[_bounded(cid, uids) for cid, uids in campaign_users.items()],
            )

        total_leads = 0
        campaigns_errors = 0
        for leads, errors in results:
            total_leads += leads
            campaigns_errors += errors

        campaigns_done = len(results)
        print(
            f"[leads-sync] done: {campaigns_done} campaigns, "
            f"{total_leads} leads, {campaigns_errors} errors"
        )
        return {"campaigns": campaigns_done, "leads": total_leads, "campaigns_failed": campaigns_errors}

    finally:
        await pool.close()


# ── Formatting ────────────────────────────────────────────────────────────────

def _format_sync_result(result: dict) -> str:
    ts = result.get("ts", "?")
    duration = result.get("duration_sec")
    dur_str = f" за {duration:.1f}с" if duration is not None else ""
    manual_str = " <i>(вручную)</i>" if result.get("manual") else ""

    if result.get("status") == "error":
        err = result.get("error", "неизвестная ошибка")
        return (
            f"❌ <b>Instantly Sync — ОШИБКА</b>{manual_str}\n"
            f"🕐 {ts}{dur_str}\n\n"
            f"<code>{err[:400]}</code>"
        )

    fetched = result.get("fetched", 0)
    added = result.get("added", 0)
    removed = result.get("removed", 0)
    updated = result.get("updated", 0)
    after = result.get("after", fetched)
    api_errors = result.get("api_errors", 0)
    analytics_synced = result.get("analytics_synced", 0)
    leads_campaigns = result.get("leads_campaigns", 0)
    leads_total = result.get("leads_total", 0)
    leads_failed = result.get("leads_campaigns_failed", 0)

    lines = [f"✅ <b>Instantly Sync</b>{manual_str}", f"🕐 {ts}{dur_str}", ""]

    lines.append(f"📋 Кампаний в Instantly: <b>{fetched}</b>")
    lines.append(f"🗃 В базе после синхронизации: <b>{after}</b>")

    changes: list[str] = []
    if added:
        changes.append(f"➕ Добавлено: <b>{added}</b>")
    if removed:
        changes.append(f"➖ Удалено (нет в Instantly): <b>{removed}</b>")
    if updated:
        changes.append(f"🔄 Обновлено: <b>{updated}</b>")
    if analytics_synced:
        changes.append(f"📊 Аналитика: <b>{analytics_synced}</b> кампаний")
    if leads_campaigns:
        changes.append(f"👥 Лиды: <b>{leads_total}</b> контактов из <b>{leads_campaigns}</b> кампаний")
    if leads_failed:
        changes.append(f"⚠️ Лиды не обновлены по <b>{leads_failed}</b> кампаниям")
    if api_errors:
        changes.append(f"⚠️ Ошибок API (с ретраями): <b>{api_errors}</b>")

    if changes:
        lines.append("")
        lines.extend(changes)
    else:
        lines.append("— Изменений нет")

    return "\n".join(lines)


# ── Health check ──────────────────────────────────────────────────────────────

async def _check_instantly_api() -> bool:
    """Quick ping: fetch 1 campaign to verify the API key and connectivity."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(
                f"{INSTANTLY_BASE}/campaigns",
                params={"limit": "1"},
                headers={"Authorization": f"Bearer {INSTANTLY_API_KEY}"},
            )
            return r.is_success
    except Exception:
        return False


# ── Sync orchestration ────────────────────────────────────────────────────────

async def run_sync(manual: bool = False) -> dict:
    """Run full sync and return result dict."""
    loop = asyncio.get_event_loop()
    t0 = loop.time()
    ts = _now_msk()

    try:
        print(f"[sync] Starting sync at {ts}…")
        campaigns, api_errors = await fetch_all_instantly_campaigns()
        print(f"[sync] Fetched {len(campaigns)} campaigns from Instantly (api_errors={api_errors})")

        stats = await sync_to_db(campaigns)

        analytics_count = 0
        try:
            campaign_ids = [c["id"] for c in campaigns if isinstance(c.get("id"), str)]
            analytics = await fetch_campaign_analytics(campaign_ids)
            print(f"[sync] Fetched analytics for {len(analytics)} campaigns")
            analytics_count = await sync_analytics_to_db(analytics)
            print(f"[sync] Analytics synced: {analytics_count} campaigns updated")
        except Exception as e:
            print(f"[sync] Analytics sync warning: {e}")

        leads_stats: dict[str, int] = {"campaigns": 0, "leads": 0}
        try:
            print("[sync] Starting client leads sync…")
            leads_stats = await sync_client_leads()
            print(f"[sync] Client leads sync OK: {leads_stats}")
        except Exception as e:
            import traceback
            print(f"[sync] Client leads sync ERROR: {e}")
            traceback.print_exc()

        duration = round(loop.time() - t0, 1)

        result: dict = {
            "status": "ok",
            "ts": ts,
            "duration_sec": duration,
            "manual": manual,
            "api_errors": api_errors,
            "analytics_synced": analytics_count,
            "leads_campaigns": leads_stats["campaigns"],
            "leads_total": leads_stats["leads"],
            "leads_campaigns_failed": leads_stats.get("campaigns_failed", 0),
            **stats,
        }
        print(
            f"[sync] Done: fetched={stats['fetched']}, added={stats['added']}, "
            f"removed={stats['removed']}, updated={stats['updated']}, "
            f"before={stats['before']}, after={stats['after']}, "
            f"api_errors={api_errors}, analytics={analytics_count}, "
            f"leads_campaigns={leads_stats['campaigns']}, leads_total={leads_stats['leads']}, "
            f"leads_failed={leads_stats.get('campaigns_failed', 0)}, "
            f"duration={duration}s"
        )
        return result

    except Exception as e:
        duration = round(loop.time() - t0, 1)
        result = {
            "status": "error",
            "ts": ts,
            "duration_sec": duration,
            "error": str(e),
            "manual": manual,
        }
        print(f"[sync] ERROR: {e}")
        return result


async def _run_sync_and_report(manual: bool = False) -> None:
    global _last_sync_result

    if _sync_lock.locked():
        if manual:
            await send_telegram("⏳ Синхронизация уже запущена, подождите...")
        return

    async with _sync_lock:
        result = await run_sync(manual=manual)
        _last_sync_result = result

        has_changes = (
            result.get("added", 0) > 0
            or result.get("removed", 0) > 0
            or result.get("api_errors", 0) > 0
            or result.get("leads_campaigns_failed", 0) > 0
            or result.get("leads_total", 0) > 0
        )

        if manual or result.get("status") == "error" or has_changes:
            await send_telegram(_format_sync_result(result))
        else:
            print(f"[sync] No changes — Telegram notification skipped")


# ── Main ──────────────────────────────────────────────────────────────────────

def _require(name: str, val: str) -> str:
    if not val:
        print(f"[sync] FATAL: {name} is not set")
        sys.exit(1)
    return val


async def main() -> None:
    _require("POLZA_INSTANTLY_SYNC_BOT_API_KEY", BOT_TOKEN)
    _require("INSTANTLY_API_KEY or INSTANTLY_PORTAL_API_KEY", INSTANTLY_API_KEY)
    _require("DATABASE_URL", DATABASE_URL)
    _require("INSTANTLY_SYNC_BOT_CHAT_ID or TELEGRAM_HEALTH_CHAT_ID", CHAT_ID)

    effective_interval_sec = max(SYNC_INTERVAL_SEC, MIN_SYNC_INTERVAL_SEC)
    if effective_interval_sec != SYNC_INTERVAL_SEC:
        print(
            f"[sync] INSTANTLY_SYNC_INTERVAL_SEC={SYNC_INTERVAL_SEC}s is below minimum "
            f"{MIN_SYNC_INTERVAL_SEC}s. Using {effective_interval_sec}s."
        )

    api_ok = await _check_instantly_api()
    api_status = "✅ API доступно" if api_ok else "⚠️ API недоступно"

    msk = timezone(timedelta(hours=3))
    next_sync_str = (datetime.now(msk) + timedelta(seconds=effective_interval_sec)).strftime("%H:%M MSK")

    await send_telegram(
        f"🟢 <b>Instantly Sync Bot ONLINE</b>\n"
        f"🕐 {_now_msk()}\n\n"
        f"🔍 Тестовый запрос выполнен — {api_status}\n"
        f"⏱ Следующее обновление в {next_sync_str}\n\n"
        f"/sync — ручной запуск · /last — последний результат · /help — справка"
    )

    # First sync immediately on startup
    await _run_sync_and_report()

    scheduler = AsyncIOScheduler()
    scheduler.add_job(
        _run_sync_and_report,
        "interval",
        seconds=effective_interval_sec,
        id="instantly_sync",
        coalesce=True,
        max_instances=1,
    )
    scheduler.start()

    poll_task = asyncio.create_task(poll_telegram_commands())

    print(
        f"[sync] Started. interval={effective_interval_sec}s, retry_attempts={RETRY_ATTEMPTS}, "
        f"leads_retry_attempts={LEADS_RETRY_ATTEMPTS}, leads_page_limit={LEADS_PAGE_LIMIT}, "
        f"leads_concurrency={LEADS_CONCURRENCY}, leads_rps={LEADS_RPS_LIMIT}. "
        f"Commands: /sync /last /help"
    )

    try:
        while True:
            await asyncio.sleep(3600)
    finally:
        poll_task.cancel()
        try:
            await poll_task
        except asyncio.CancelledError:
            pass


if __name__ == "__main__":
    asyncio.run(main())

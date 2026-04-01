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
  DATABASE_URL                        — PostgreSQL connection string
  INSTANTLY_SYNC_BOT_CHAT_ID или TELEGRAM_HEALTH_CHAT_ID — чат для отчётов
"""
from __future__ import annotations

import asyncio
import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

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
DATABASE_URL: str = (os.environ.get("DATABASE_URL") or os.environ.get("SUPABASE_DB_URL") or "")

SYNC_INTERVAL_SEC: int = int(os.environ.get("INSTANTLY_SYNC_INTERVAL_SEC", str(60 * 60)))  # 1 hour
INSTANTLY_BASE = "https://api.instantly.ai/api/v2"
PAGE_LIMIT = 100
MAX_PAGES = 200
NAME_MAX_LEN = 2000

HTTP_TIMEOUT: int = int(os.environ.get("INSTANTLY_SYNC_HTTP_TIMEOUT_SEC", "30"))
RETRY_ATTEMPTS: int = int(os.environ.get("INSTANTLY_SYNC_RETRY_ATTEMPTS", "3"))

_CONNECT_KWARGS: dict = {"statement_cache_size": 0}

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
        duration = round(loop.time() - t0, 1)

        result: dict = {
            "status": "ok",
            "ts": ts,
            "duration_sec": duration,
            "manual": manual,
            "api_errors": api_errors,
            **stats,
        }
        print(
            f"[sync] Done: fetched={stats['fetched']}, added={stats['added']}, "
            f"removed={stats['removed']}, updated={stats['updated']}, "
            f"before={stats['before']}, after={stats['after']}, "
            f"api_errors={api_errors}, duration={duration}s"
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

    api_ok = await _check_instantly_api()
    api_status = "✅ API доступно" if api_ok else "⚠️ API недоступно"

    msk = timezone(timedelta(hours=3))
    next_sync_str = (datetime.now(msk) + timedelta(seconds=SYNC_INTERVAL_SEC)).strftime("%H:%M MSK")

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
        lambda: asyncio.create_task(_run_sync_and_report()),
        "interval",
        seconds=SYNC_INTERVAL_SEC,
        id="instantly_sync",
    )
    scheduler.start()

    poll_task = asyncio.create_task(poll_telegram_commands())

    print(
        f"[sync] Started. interval={SYNC_INTERVAL_SEC}s, "
        f"retry_attempts={RETRY_ATTEMPTS}. Commands: /sync /last /help"
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

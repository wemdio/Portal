"""
Health-check & daily report bot for polza-portal.ru.

Health check (every 5 min):
  - Site availability (polza-portal.ru)
  - Database connectivity + connection count
  - All proxies (HH + Search)
  - S3 storage (Supabase Storage)
  - Server ping (144.31.54.166)
  → If any check fails, immediately sends alert to Telegram.

Daily report (21:00 MSK):
  - Jobs completed today: totals + per type (completed / failed + errors)
  - Current DB connections
  - Proxy status: which work, which don't
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.parse import urlparse

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
from apscheduler.triggers.cron import CronTrigger

# ── Config ──────────────────────────────────────────────────────────────────

PORTAL_URL = os.environ.get("HEALTH_PORTAL_URL", "https://polza-portal.ru")
DATABASE_URL = os.environ.get("DATABASE_URL") or os.environ.get("SUPABASE_DB_URL")
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_HEALTH_BOT_TOKEN") or os.environ.get("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_HEALTH_CHAT_ID")
HEALTH_INTERVAL_SEC = int(os.environ.get("HEALTH_INTERVAL_SEC", "300"))
HTTP_TIMEOUT = int(os.environ.get("HEALTH_HTTP_TIMEOUT_SEC", "15"))
SERVER_IP = os.environ.get("HEALTH_SERVER_IP", "144.31.54.166")

S3_ENDPOINT = os.environ.get("S3_ENDPOINT", "")
S3_BUCKET = os.environ.get("S3_BUCKET", "")

HH_PROXY_URLS: list[str] = []
SEARCH_PROXY_URLS: list[str] = []

def _parse_proxy_list(raw: str) -> list[str]:
    raw = raw.strip()
    if not raw:
        return []
    if raw.startswith("["):
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                return [str(u).strip() for u in parsed if u]
        except json.JSONDecodeError:
            pass
    return [u.strip() for u in raw.split(",") if u.strip()]

HH_PROXY_URLS = _parse_proxy_list(os.environ.get("HH_PROXY_URLS", ""))
SEARCH_PROXY_URLS = _parse_proxy_list(os.environ.get("SEARCH_PROXY_URLS", ""))

ALL_PROXIES: list[tuple[str, str]] = []
_proxy_groups: dict[str, list[str]] = {}
for url in HH_PROXY_URLS:
    _proxy_groups.setdefault(url, []).append("HH")
for url in SEARCH_PROXY_URLS:
    _proxy_groups.setdefault(url, []).append("Search")
for url, groups in _proxy_groups.items():
    ALL_PROXIES.append(("+".join(sorted(set(groups))), url))


def _require(name: str, val: str | None) -> str:
    if not val:
        print(f"[health] FATAL: {name} not set")
        sys.exit(1)
    return val


def _redact(proxy_url: str) -> str:
    try:
        p = urlparse(proxy_url)
        return f"{p.hostname}:{p.port}"
    except Exception:
        return proxy_url[:30]


def _now_msk() -> str:
    msk = timezone(timedelta(hours=3))
    return datetime.now(msk).strftime("%d.%m.%Y %H:%M MSK")


# ── Telegram ────────────────────────────────────────────────────────────────

async def send_telegram(text: str, parse_mode: str = "HTML") -> bool:
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        return False
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": text,
        "parse_mode": parse_mode,
        "disable_web_page_preview": True,
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(url, json=payload)
            if not r.is_success:
                print(f"[health] TG error {r.status_code}: {r.text[:200]}")
            return r.is_success
    except Exception as e:
        print(f"[health] TG send error: {e}")
        return False


async def send_startup_message() -> None:
    text = (
        "✅ <b>Health-check запущен</b>\n\n"
        f"Портал: <code>{PORTAL_URL}</code>\n"
        f"Интервал health-check: {HEALTH_INTERVAL_SEC // 60} мин\n"
        "Дневной отчёт: 21:00 MSK\n"
        f"Сервер IP: {SERVER_IP}\n\n"
        f"🕐 {_now_msk()}"
    )
    await send_telegram(text)


# ── Individual checks ───────────────────────────────────────────────────────

async def check_site() -> tuple[bool, str]:
    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT, follow_redirects=True) as c:
            r = await c.get(PORTAL_URL)
            if r.status_code >= 400:
                return False, f"HTTP {r.status_code}"
            return True, f"OK ({r.status_code})"
    except httpx.TimeoutException:
        return False, "timeout"
    except Exception as e:
        return False, str(e)[:120]


async def check_db() -> tuple[bool, str, int | None, int | None]:
    """Returns (ok, message, current_connections, max_connections)."""
    if not DATABASE_URL:
        return False, "DATABASE_URL not set", None, None
    try:
        conn = await asyncpg.connect(DATABASE_URL)
        try:
            await conn.execute("SELECT 1")
            cur = await conn.fetchval(
                "SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()"
            )
            max_raw = await conn.fetchval("SHOW max_connections")
            max_c = int(max_raw) if max_raw else None
            return True, "OK", cur, max_c
        finally:
            await conn.close()
    except Exception as e:
        return False, str(e)[:120], None, None


async def check_proxy(proxy_url: str) -> tuple[bool, str]:
    """Try to make a request through the proxy to httpbin."""
    try:
        async with httpx.AsyncClient(
            proxy=proxy_url,
            timeout=HTTP_TIMEOUT,
        ) as c:
            r = await c.get("https://httpbin.org/ip")
            if r.status_code == 200:
                return True, "OK"
            return False, f"HTTP {r.status_code}"
    except Exception as e:
        return False, str(e)[:80]


async def check_all_proxies() -> list[tuple[str, str, bool, str]]:
    """Returns list of (group, redacted_url, ok, message)."""
    results: list[tuple[str, str, bool, str]] = []
    tasks = []
    for group, url in ALL_PROXIES:
        tasks.append(check_proxy(url))
    outcomes = await asyncio.gather(*tasks, return_exceptions=True)
    for (group, url), outcome in zip(ALL_PROXIES, outcomes):
        if isinstance(outcome, Exception):
            results.append((group, _redact(url), False, str(outcome)[:80]))
        else:
            ok, msg = outcome
            results.append((group, _redact(url), ok, msg))
    return results


async def check_s3() -> tuple[bool, str]:
    """Check Supabase Storage / S3 availability via HEAD on the endpoint."""
    if not S3_ENDPOINT:
        return True, "not configured (skip)"
    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as c:
            r = await c.head(S3_ENDPOINT)
            if r.status_code < 500:
                return True, f"OK ({r.status_code})"
            return False, f"HTTP {r.status_code}"
    except httpx.TimeoutException:
        return False, "timeout"
    except Exception as e:
        return False, str(e)[:120]


async def check_server() -> tuple[bool, str]:
    """Ping server by making a TCP connection to port 22 or 80."""
    if not SERVER_IP:
        return True, "not configured (skip)"
    for port in (80, 443, 22):
        try:
            _, writer = await asyncio.wait_for(
                asyncio.open_connection(SERVER_IP, port),
                timeout=5,
            )
            writer.close()
            await writer.wait_closed()
            return True, f"OK (port {port})"
        except Exception:
            continue
    return False, f"Сервер {SERVER_IP} не отвечает ни на одном порту (80/443/22)"


# ── Health check (every 5 min) ──────────────────────────────────────────────

async def run_health_check():
    """Check all services. Alert immediately on any failure."""
    problems: list[str] = []

    site_ok, site_msg = await check_site()
    if not site_ok:
        problems.append(f"🔴 <b>Сайт</b> {PORTAL_URL}: {site_msg}")

    db_ok, db_msg, db_cur, db_max = await check_db()
    if not db_ok:
        problems.append(f"🔴 <b>БД</b>: {db_msg}")
    elif db_cur is not None and db_max is not None:
        usage_pct = db_cur / db_max * 100
        if usage_pct > 80:
            problems.append(
                f"🟡 <b>БД connections</b>: {db_cur}/{db_max} ({usage_pct:.0f}%)"
            )

    proxy_results = await check_all_proxies()
    dead_proxies = [(g, addr, msg) for g, addr, ok, msg in proxy_results if not ok]
    if dead_proxies:
        total = len(ALL_PROXIES)
        alive = total - len(dead_proxies)
        lines = [f"🔴 <b>Прокси</b>: {alive}/{total} работают"]
        for g, addr, msg in dead_proxies:
            lines.append(f"  ✖ [{g}] {addr}: {msg}")
        problems.append("\n".join(lines))

    s3_ok, s3_msg = await check_s3()
    if not s3_ok:
        problems.append(f"🔴 <b>S3 хранилище</b>: {s3_msg}")

    srv_ok, srv_msg = await check_server()
    if not srv_ok:
        problems.append(f"🔴 <b>Сервер {SERVER_IP}</b>: {srv_msg}")

    if problems:
        header = f"⚠️ <b>HEALTH CHECK</b>  —  {_now_msk()}\n"
        text = header + "\n" + "\n\n".join(problems)
        await send_telegram(text)
        print(f"[health] ALERT sent: {len(problems)} problem(s)")
    else:
        print(f"[health] OK at {_now_msk()}")


# ── Daily report (21:00 MSK) ────────────────────────────────────────────────

JOB_TABLES = [
    ("parser_jobs", "HH парсер"),
    ("search_parser_jobs", "Search парсер"),
    ("website_enrichment_jobs", "Website enrichment"),
    ("yandex_maps_jobs", "Яндекс.Карты"),
    ("brief_scoring_jobs", "Brief scoring"),
    ("email_validation_jobs", "Email validation"),
    ("tg_outreach_campaigns", "TG Outreach"),
]


async def _fetch_daily_jobs(conn: asyncpg.Connection) -> str:
    """Build daily jobs summary text."""
    lines: list[str] = []
    total_ok = 0
    total_fail = 0

    for table, label in JOB_TABLES:
        try:
            if table == "tg_outreach_campaigns":
                completed = await conn.fetchval(
                    f"SELECT count(*)::int FROM {table} WHERE status = 'stopped' AND updated_at >= CURRENT_DATE"
                ) or 0
                failed = await conn.fetchval(
                    f"SELECT count(*)::int FROM {table} WHERE status = 'error' AND updated_at >= CURRENT_DATE"
                ) or 0
            else:
                completed = await conn.fetchval(
                    f"SELECT count(*)::int FROM {table} WHERE status = 'completed' AND completed_at >= CURRENT_DATE"
                ) or 0
                failed = await conn.fetchval(
                    f"SELECT count(*)::int FROM {table} WHERE status = 'failed' AND completed_at >= CURRENT_DATE"
                ) or 0

            total_ok += completed
            total_fail += failed

            if completed + failed == 0:
                continue

            status_text = f"✅ {completed}"
            if failed > 0:
                status_text += f"  ❌ {failed}"
            lines.append(f"  • {label}: {status_text}")

            if failed > 0:
                try:
                    errors = await conn.fetch(
                        f"SELECT error_message FROM {table} WHERE status = 'failed' AND completed_at >= CURRENT_DATE AND error_message IS NOT NULL LIMIT 3"
                    )
                    for err_row in errors:
                        msg = (err_row["error_message"] or "")[:100]
                        if msg:
                            lines.append(f"      ↳ {msg}")
                except Exception:
                    pass
        except Exception:
            lines.append(f"  • {label}: ⚠️ не удалось получить данные")

    header = f"<b>Задачи за сегодня</b>: ✅ {total_ok}  ❌ {total_fail}"
    if lines:
        return header + "\n" + "\n".join(lines)
    return header + "\n  Нет задач за сегодня"


async def run_daily_report():
    """21:00 MSK daily report."""
    sections: list[str] = []

    # ── 1. Jobs ──
    if DATABASE_URL:
        try:
            conn = await asyncpg.connect(DATABASE_URL)
            try:
                jobs_text = await _fetch_daily_jobs(conn)
                sections.append(jobs_text)

                # ── 2. DB connections ──
                cur = await conn.fetchval(
                    "SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()"
                )
                max_raw = await conn.fetchval("SHOW max_connections")
                max_c = int(max_raw) if max_raw else "?"
                sections.append(f"<b>БД</b>: ✅ OK ({cur} / {max_c} подключений)")
            finally:
                await conn.close()
        except Exception as e:
            sections.append(f"<b>БД</b>: ❌ {str(e)[:120]}")
    else:
        sections.append("<b>БД</b>: ❌ DATABASE_URL не задан")

    # ── 2. Site & server ──
    site_ok, site_msg = await check_site()
    if site_ok:
        sections.append(f"<b>Сайт</b> {PORTAL_URL}: ✅ {site_msg}")
    else:
        sections.append(f"<b>Сайт</b> {PORTAL_URL}: ❌ {site_msg}")

    srv_ok, srv_msg = await check_server()
    if srv_ok:
        sections.append(f"<b>Сервер {SERVER_IP}</b>: ✅ {srv_msg}")
    else:
        sections.append(f"<b>Сервер {SERVER_IP}</b>: ❌ {srv_msg}")

    # ── 3. Proxies ──
    proxy_results = await check_all_proxies()
    alive = sum(1 for *_, ok, _ in proxy_results if ok)
    total = len(proxy_results)

    if total == 0:
        sections.append("<b>Прокси</b>: не настроены")
    else:
        proxy_lines = [f"<b>Прокси</b>: {alive}/{total} работают"]
        for group, addr, ok, msg in proxy_results:
            icon = "✅" if ok else "❌"
            proxy_lines.append(f"  {icon} [{group}] {addr}" + (f" — {msg}" if not ok else ""))
        sections.append("\n".join(proxy_lines))

    # ── Build message ──
    header = f"📊 <b>Дневной отчёт</b>  —  {_now_msk()}\n"
    text = header + "\n" + "\n\n".join(sections)

    await send_telegram(text)
    print(f"[health] Daily report sent at {_now_msk()}")


# ── Main ────────────────────────────────────────────────────────────────────

async def main():
    _require("DATABASE_URL or SUPABASE_DB_URL", DATABASE_URL)
    _require("TELEGRAM_HEALTH_CHAT_ID", TELEGRAM_CHAT_ID)
    _require("TELEGRAM_HEALTH_BOT_TOKEN or TELEGRAM_BOT_TOKEN", TELEGRAM_BOT_TOKEN)

    scheduler = AsyncIOScheduler()

    # Health check every 5 min
    scheduler.add_job(
        run_health_check, "interval",
        seconds=HEALTH_INTERVAL_SEC,
        id="health",
    )

    # Daily report at 21:00 MSK (18:00 UTC)
    scheduler.add_job(
        run_daily_report,
        CronTrigger(hour=18, minute=0, timezone="UTC"),
        id="daily",
    )

    # Run first health check now
    await run_health_check()

    scheduler.start()

    await send_startup_message()

    proxy_count = len(ALL_PROXIES)
    print(
        f"[health] Started: site={PORTAL_URL}, server={SERVER_IP}, "
        f"proxies={proxy_count}, health every {HEALTH_INTERVAL_SEC}s, daily at 21:00 MSK"
    )

    while True:
        await asyncio.sleep(3600)


if __name__ == "__main__":
    asyncio.run(main())

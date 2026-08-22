"""
Health-check & daily report bot for polza-portal.ru.

Health check (every 15 min):
  - Site availability (polza-portal.ru)
  - Database connectivity + connection count
  - All proxies (HH + Search)
  - S3 storage (Supabase Storage)
  - Server ping (139.60.162.12)
  → If any check fails, immediately sends alert to Telegram.

Daily report (21:00 MSK):
  - Jobs completed today: totals + per type (completed / failed + errors)
  - Current DB connections
  - Proxy status: which work, which don't
"""
from __future__ import annotations

import asyncio
import html
import io
import json
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from pathlib import Path
from collections import deque
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

try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.ticker import MaxNLocator
    HAS_MATPLOTLIB = True
except ImportError:
    HAS_MATPLOTLIB = False

# ── Config ──────────────────────────────────────────────────────────────────

PORTAL_URL = os.environ.get("HEALTH_PORTAL_URL", "https://polza-portal.ru")
DATABASE_URL = os.environ.get("DATABASE_URL") or os.environ.get("SUPABASE_DB_URL")
INSTANTLY_DATABASE_URL = os.environ.get("INSTANTLY_DATABASE_URL")
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_HEALTH_BOT_TOKEN") or os.environ.get("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_HEALTH_CHAT_ID")
HTTP_TIMEOUT = int(os.environ.get("HEALTH_HTTP_TIMEOUT_SEC", "15"))
SERVER_IP = os.environ.get("HEALTH_SERVER_IP", "139.60.162.12")
HEALTH_RETRY_ATTEMPTS = max(1, int(os.environ.get("HEALTH_RETRY_ATTEMPTS", "3")))
HEALTH_RETRY_DELAY_SEC = max(0.0, float(os.environ.get("HEALTH_RETRY_DELAY_SEC", "1.0")))
HEALTH_INTERVAL_SEC = int(os.environ.get("HEALTH_INTERVAL_SEC", "900"))
JOB_MONITOR_INTERVAL_SEC = max(
    60, int(os.environ.get("HEALTH_JOB_MONITOR_INTERVAL_SEC", "300"))
)
# 20, а не 15: baseConstructor-воркер сам резюмит осиротевшую задачу через
# BASE_CONSTRUCTOR_STALE_MINUTES=15 (docker-compose.prod.yml). Пока пороги были
# равны, каждый деплой, заставший работающие задачи, давал ложную тревогу за
# секунды до самоподбора — инцидент 11.08.2026, три задачи конструктора баз.
# Порог монитора обязан быть заметно больше порога автоподбора.
JOB_STUCK_MINUTES = max(
    2, int(os.environ.get("HEALTH_JOB_STUCK_MIN", "20"))
)
# Proxies are checked on their own slower cadence (default 5 min) so a flaky
# test target can't spam the chat, and so we don't hammer the proxy pool every
# health cycle. The main cycle (site/DB) still runs every HEALTH_INTERVAL_SEC.
PROXY_CHECK_INTERVAL_SEC = max(60, int(os.environ.get("PROXY_CHECK_INTERVAL_SEC", "300")))
HEARTBEAT_INTERVAL_SEC = max(60, int(os.environ.get("HEARTBEAT_INTERVAL_SEC", "1800")))
DEADMAN_GRACE_SEC = max(120, int(os.environ.get("HEALTH_DEADMAN_GRACE_SEC", str(HEALTH_INTERVAL_SEC * 3))))

# Суточные пайплайны (OutreachOS + Mailganer auto-pipeline). Отдельные пороги от
# JOB_STUCK_MINUTES: прогоны идут часами, «завис» — только когда даже самый
# длинный легитимный прогон уже не мог бы идти.
# Самый долгий завершившийся прогон OutreachOS — ~117 мин, берём 180 с запасом.
OUTREACHOS_STUCK_MINUTES = max(30, int(os.environ.get("HEALTH_OUTREACHOS_STUCK_MIN", "180")))
# Прогон стартует кроном в 02:00 UTC (05:00 МСК); если к этому часу (UTC) строки
# за сегодня нет — крон не отработал (ребут, зомби-лок, падение докера).
OUTREACHOS_MISSING_AFTER_UTC_HOUR = max(0, int(os.environ.get("HEALTH_OUTREACHOS_MISSING_AFTER_UTC_HOUR", "4")))
# Auto-pipeline обновляет heartbeat_at по ходу прогона; 30 мин без heartbeat —
# завис (воркер умер / БД-коннект ушёл).
AUTOPIPELINE_STUCK_MINUTES = max(15, int(os.environ.get("HEALTH_AUTOPIPELINE_STUCK_MIN", "30")))
HEALTH_CRITICAL_ENDPOINTS_RAW = os.environ.get(
    "HEALTH_CRITICAL_ENDPOINTS",
    "/,/tools,/api/user/tools",
)
SUPABASE_REST_URL = os.environ.get("SUPABASE_REST_URL")
if not SUPABASE_REST_URL:
    _supabase_base = (
        os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
        or os.environ.get("SUPABASE_URL")
        or ""
    ).rstrip("/")
    SUPABASE_REST_URL = f"{_supabase_base}/rest/v1/" if _supabase_base else ""
SUPABASE_REST_API_KEY = (
    os.environ.get("SUPABASE_HEALTH_API_KEY")
    or os.environ.get("NEXT_PUBLIC_SUPABASE_ANON_KEY")
    or os.environ.get("SUPABASE_ANON_KEY")
    or ""
)
# Timeout specifically for PostgREST — higher than general HTTP_TIMEOUT because
# Supabase projects can cold-start (wake from pause) in 30–60 s.
HEALTH_POSTGREST_TIMEOUT_SEC = int(os.environ.get("HEALTH_POSTGREST_TIMEOUT_SEC", "30"))
# How often to silently ping PostgREST to prevent Supabase from pausing (0 = disabled).
SUPABASE_KEEPALIVE_INTERVAL_SEC = int(os.environ.get("SUPABASE_KEEPALIVE_INTERVAL_SEC", "600"))

# Alert only after this many consecutive failed check cycles (default 2).
# Set to 1 to restore legacy "alert on every failure" behaviour.
HEALTH_ALERT_MIN_CONSECUTIVE = max(1, int(os.environ.get("HEALTH_ALERT_MIN_CONSECUTIVE", "2")))
# Re-send an ongoing alert every this many additional failed cycles (0 = never repeat).
HEALTH_ALERT_REPEAT_CYCLES = max(0, int(os.environ.get("HEALTH_ALERT_REPEAT_CYCLES", "15")))

# Per-check consecutive-failure counters; reset to 0 on first success.
_FAIL_COUNT: dict[str, int] = {}

S3_ENDPOINT = os.environ.get("S3_ENDPOINT", "")
S3_BUCKET = os.environ.get("S3_BUCKET", "")

DISK_TOTAL_GB = float(os.environ.get("HEALTH_DISK_TOTAL_GB", "80"))
DISK_WARN_GB = float(os.environ.get("HEALTH_DISK_WARN_GB", "72"))

# ── Per-container resource watchdog ──────────────────────────────────────────
# Alert when a container uses >= HEALTH_CONTAINER_USAGE_PCT of ITS OWN cgroup
# memory limit or CPU quota. Container name is included so the operator can
# jump straight to it. Requires read-only access to /var/run/docker.sock.
# Signal is per-cycle without dedup — set threshold to a value where sustained
# breach genuinely needs a look (default 80). Set to 0 to disable the check.
HEALTH_CONTAINER_USAGE_PCT = int(os.environ.get("HEALTH_CONTAINER_USAGE_PCT", "80"))
DOCKER_SOCK_PATH = os.environ.get("DOCKER_SOCK", "/var/run/docker.sock")

# ── Broken-healthcheck / pids-limit watchdog ─────────────────────────────────
# Added 23.07.2026 after server hang caused by 15h of failed-exec loop from a
# broken healthcheck on distroless postgrest containers. 700 error lines per
# minute in dockerd, millions of closed FIFOs, PID/FD leak, hang.
#
# What we watch:
# 1) Any container whose Health.FailingStreak >= HEALTH_CONTAINER_FAILING_STREAK
#    for HEALTH_CONTAINER_FAILING_STREAK_ALERT_MIN minutes — that is a *broken*
#    healthcheck, not a sick service (a sick service either self-heals or trips
#    the deadman alert). We include the healthcheck command, the last error
#    line, and a hint about the most common cause matching the error text.
# 2) Any container whose pids usage exceeds HEALTH_CONTAINER_PIDS_PCT of its
#    cgroup pids limit — early warning for the fork-bomb scenario that killed
#    the box today. Silent when no pids limit is set on the container.
#
# Dedup per (container_id, container_created_at): one alert per broken container
# per lifetime. Recreating the container (force-recreate) clears the dedup key.
HEALTH_CONTAINER_FAILING_STREAK = int(os.environ.get("HEALTH_CONTAINER_FAILING_STREAK", "20"))
HEALTH_CONTAINER_PIDS_PCT = int(os.environ.get("HEALTH_CONTAINER_PIDS_PCT", "80"))
# In-memory dedup: alert once per (container_id, created_at). Cleared for
# containers that disappeared on the next scan so the set doesn't grow forever.
_CONTAINER_HEALTH_ALERTED: set[str] = set()

PROXY_URLS: list[str] = []

LAST_HEALTH_CHECK_TS = 0.0
# Loop-clock timestamp of the last proxy check; gates proxies to their own
# slower cadence (PROXY_CHECK_INTERVAL_SEC) inside the faster health cycle.
LAST_PROXY_CHECK_TS = 0.0
HEARTBEAT_STARTED = False

# ── Metrics buffer for heartbeat charts ──────────────────────────────────────

SPARK_CHARS = "▁▂▃▄▅▆▇█"

# (monotonic_ts, active_connections, cumulative_txn_count)
_METRICS: deque[tuple[float, int, int]] = deque(maxlen=60)
_METRICS_INSTANTLY: deque[tuple[float, int, int]] = deque(maxlen=60)


def _spark(values: list[int | float]) -> str:
    if not values or len(values) < 2:
        return ""
    mn, mx = min(values), max(values)
    if mn == mx:
        return "▄" * len(values)
    rng = mx - mn
    return "".join(
        SPARK_CHARS[min(7, int((v - mn) / rng * 7))]
        for v in values
    )


def _fmt_bytes(b: int | float) -> str:
    for u in ("B", "KB", "MB", "GB", "TB"):
        if abs(b) < 1024:
            return f"{b:.2f} {u}" if u not in ("B", "KB") else f"{int(b)} {u}"
        b = b / 1024
    return f"{b:.2f} PB"


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

PROXY_URLS = _parse_proxy_list(os.environ.get("PROXY_URLS", ""))
CRITICAL_ENDPOINTS = _parse_proxy_list(HEALTH_CRITICAL_ENDPOINTS_RAW)

# Targets used to probe whether a proxy can carry traffic. Tried in order until
# one gives a definitive answer. Using several independent, high-uptime targets
# means one target's outage (the old single httpbin.org would 5xx for days at a
# time) can't make every proxy look dead. Cloudflare's trace endpoint is first
# because of its uptime and because it echoes the exit IP for free.
PROXY_TEST_URLS = _parse_proxy_list(
    os.environ.get(
        "PROXY_TEST_URLS",
        "https://www.cloudflare.com/cdn-cgi/trace,https://api.ipify.org?format=json",
    )
) or ["https://www.cloudflare.com/cdn-cgi/trace"]

ALL_PROXIES: list[tuple[str, str]] = [(f"Proxy{i+1}", url) for i, url in enumerate(PROXY_URLS)]


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


def _format_exception_message(error: Exception, limit: int = 120) -> str:
    """Return non-empty, compact exception text for Telegram alerts."""
    message = str(error).strip()
    if message:
        return message[:limit]
    return f"{error.__class__.__name__}: no details"[:limit]


def _normalize_network_error(error: Exception, limit: int = 120) -> str:
    """Map noisy/empty transport errors to concise, actionable text."""
    text = _format_exception_message(error, limit=limit)
    lowered = text.lower()
    if (
        "temporary failure in name resolution" in lowered
        or "name or service not known" in lowered
        or "nodename nor servname provided" in lowered
        or "getaddrinfo failed" in lowered
    ):
        return "DNS resolution failed"
    if isinstance(error, httpx.TimeoutException) or "timed out" in lowered or "timeout" in lowered:
        return "timeout"
    if "all connection attempts failed" in lowered:
        return "connection attempts failed"
    return text


# ── Settings (mute alerts) ───────────────────────────────────────────────────

SETTINGS_TABLE = "health_check_settings"
JOB_ALERTS_TABLE = "health_check_job_alerts"

# PgBouncer in transaction mode: prepared statements are not supported (per-connection).
# Disable asyncpg statement cache to avoid "prepared statement already exists".
_CONNECT_KWARGS: dict = {"statement_cache_size": 0, "timeout": 15, "command_timeout": 15}


def _connect_kwargs(command_timeout: int) -> dict:
    """Те же параметры подключения, но со своим потолком на длительность запроса.

    Пятнадцать секунд рассчитаны на проверки здоровья: они ходят часто, и
    зависший запрос там надо обрывать быстро. Ежедневным отчётам этот потолок не
    подходит — они считают агрегаты по всей таблице, их никто не ждёт, и обрыв
    оставляет команду вообще без отчёта.
    """
    return {**_CONNECT_KWARGS, "command_timeout": command_timeout}


# Отчёт по LinkedIn-аутричу считает агрегаты по всей переписке всех лидов. Он
# уходит раз в сутки в 19:00 МСК, никто его не ждёт, поэтому потолок щедрый:
# 08.08.2026 отчёт упал с «TimeoutError: no details», не уложившись в 15 секунд.
LI_REPORT_COMMAND_TIMEOUT_SEC = 180

# Окно, в котором дубль сообщения считается актуальным отклонением, а не
# историей. Инвариант должен ловить живой рецидив; без окна счётчик копит
# события навсегда и отчёт остаётся красным даже после починки причины.
LI_DUP_WINDOW_DAYS = 14


async def _ensure_settings_table() -> None:
    """Create health-check state tables."""
    conn = await asyncpg.connect(DATABASE_URL, **_CONNECT_KWARGS)
    try:
        await conn.execute(
            f"CREATE TABLE IF NOT EXISTS {SETTINGS_TABLE} "
            "(id int PRIMARY KEY DEFAULT 1, send_alerts boolean NOT NULL DEFAULT true)"
        )
        await conn.execute(
            f"CREATE TABLE IF NOT EXISTS {JOB_ALERTS_TABLE} ("
            "alert_key text PRIMARY KEY, "
            "alerted_at timestamptz NOT NULL DEFAULT now())"
        )
        await conn.execute(
            f"DELETE FROM {JOB_ALERTS_TABLE} "
            "WHERE alerted_at < now() - interval '90 days' "
            "AND alert_key <> 'job-monitor:v1:initialized'"
        )
    finally:
        await conn.close()


async def get_send_alerts() -> bool:
    """Whether to send alerts to the chat (can be turned off with /mute in Telegram)."""
    if not DATABASE_URL:
        return True
    try:
        conn = await asyncpg.connect(DATABASE_URL, **_CONNECT_KWARGS)
        try:
            row = await conn.fetchrow(
                f"SELECT send_alerts FROM {SETTINGS_TABLE} WHERE id = 1"
            )
            return row["send_alerts"] if row else True
        finally:
            await conn.close()
    except Exception as e:
        print(f"[health] get_send_alerts error: {e}")
        return True


async def set_send_alerts(enabled: bool) -> None:
    if not DATABASE_URL:
        return
    try:
        conn = await asyncpg.connect(DATABASE_URL, **_CONNECT_KWARGS)
        try:
            await conn.execute(
                f"INSERT INTO {SETTINGS_TABLE} (id, send_alerts) VALUES (1, $1) "
                "ON CONFLICT (id) DO UPDATE SET send_alerts = EXCLUDED.send_alerts",
                enabled,
            )
        finally:
            await conn.close()
    except Exception as e:
        print(f"[health] set_send_alerts error: {e}")


# ── Telegram ────────────────────────────────────────────────────────────────

async def send_telegram(text: str, parse_mode: str = "HTML", force: bool = False) -> bool:
    """Send message to the health chat. If force=False and alerts are muted, skips sending."""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        return False
    if not force and not await get_send_alerts():
        return True  # muted, don't send (but don't treat as error)
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


async def send_telegram_photo(
    photo_bytes: bytes,
    caption: str = "",
    force: bool = False,
) -> bool:
    """Send a photo with caption to the health chat."""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        return False
    if not force and not await get_send_alerts():
        return True
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendPhoto"
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(
                url,
                data={
                    "chat_id": TELEGRAM_CHAT_ID,
                    "caption": caption,
                    "parse_mode": "HTML",
                },
                files={"photo": ("heartbeat.png", photo_bytes, "image/png")},
            )
            if not r.is_success:
                print(f"[health] TG photo error {r.status_code}: {r.text[:200]}")
            return r.is_success
    except Exception as e:
        print(f"[health] TG photo error: {e}")
        return False


async def _send_telegram_raw(text: str) -> bool:
    """Send to Telegram without checking mute (for command replies)."""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        return False
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(url, json=payload)
            return r.is_success
    except Exception as e:
        print(f"[health] TG send error: {e}")
        return False


async def poll_telegram_commands() -> None:
    """Long-poll Telegram for /mute, /unmute, /alerts in the health chat."""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        return
    chat_id_str = str(TELEGRAM_CHAT_ID).strip()
    last_update_id = 0
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/getUpdates"
    while True:
        try:
            async with httpx.AsyncClient(timeout=35) as client:
                r = await client.get(
                    url,
                    params={"offset": last_update_id + 1, "timeout": 30},
                )
            if not r.is_success:
                await asyncio.sleep(5)
                continue
            data = r.json()
            for upd in data.get("result", []):
                last_update_id = max(last_update_id, upd.get("update_id", 0))
                msg = upd.get("message") or {}
                if str(msg.get("chat", {}).get("id")) != chat_id_str:
                    continue
                text = (msg.get("text") or "").strip().lower()
                if not text:
                    continue
                if text in ("/mute", "/тихо", "/alerts_off", "/выкл", "/off"):
                    await set_send_alerts(False)
                    await _send_telegram_raw(
                        "🔇 <b>Уведомления отключены.</b> Проверки продолжают работать, в чат ничего не приходит. Чтобы снова включить — напишите /вкл"
                    )
                elif text in ("/unmute", "/вкл", "/alerts_on", "/on"):
                    await set_send_alerts(True)
                    await _send_telegram_raw("🔔 <b>Уведомления включены.</b>")
                elif text in ("/alerts", "/статус", "/status"):
                    enabled = await get_send_alerts()
                    status = "включены 🔔" if enabled else "отключены 🔇"
                    await _send_telegram_raw(f"Уведомления: {status}")
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"[health] poll_telegram error: {e}")
            await asyncio.sleep(5)


# ── Individual checks ───────────────────────────────────────────────────────

async def check_site() -> tuple[bool, str]:
    # Do not follow redirects: validate the public entrypoint itself.
    # 2xx-3xx are OK (307 → /login is expected for unauth users).
    last_error: str = "unknown"
    for attempt in range(1, HEALTH_RETRY_ATTEMPTS + 1):
        try:
            async with httpx.AsyncClient(timeout=HTTP_TIMEOUT, follow_redirects=False) as c:
                r = await c.get(PORTAL_URL)
                if r.status_code >= 400:
                    last_error = f"HTTP {r.status_code}"
                else:
                    return True, f"OK ({r.status_code})"
        except httpx.TimeoutException:
            last_error = "timeout"
        except Exception as e:
            last_error = _normalize_network_error(e)

        if attempt < HEALTH_RETRY_ATTEMPTS:
            print(f"[health] site check attempt {attempt}/{HEALTH_RETRY_ATTEMPTS}: {last_error}")
            await asyncio.sleep(HEALTH_RETRY_DELAY_SEC * attempt)

    return False, last_error


async def check_critical_endpoint(path_or_url: str) -> tuple[bool, str, str]:
    raw = (path_or_url or "").strip()
    if not raw:
        return True, "skip", "empty endpoint"
    if raw.startswith("http://") or raw.startswith("https://"):
        target = raw
    else:
        target = f"{PORTAL_URL.rstrip('/')}/{raw.lstrip('/')}"

    last_error: str = "unknown"
    for attempt in range(1, HEALTH_RETRY_ATTEMPTS + 1):
        try:
            async with httpx.AsyncClient(timeout=HTTP_TIMEOUT, follow_redirects=False) as c:
                r = await c.get(target)
                if r.status_code >= 500:
                    last_error = f"HTTP {r.status_code}"
                else:
                    return True, target, f"OK ({r.status_code})"
        except httpx.TimeoutException:
            last_error = "timeout"
        except Exception as e:
            last_error = _normalize_network_error(e)

        if attempt < HEALTH_RETRY_ATTEMPTS:
            await asyncio.sleep(HEALTH_RETRY_DELAY_SEC * attempt)

    return False, target, last_error


async def check_postgrest() -> tuple[bool, str]:
    """Check that PostgREST entrypoint is reachable (not 5xx/timeout).

    Uses a longer timeout than general HTTP checks because Supabase projects may
    cold-start (wake from pause) in 30–60 s.  Retries mirror check_db() logic.
    """
    if not SUPABASE_REST_URL:
        return True, "not configured (skip)"
    headers = {}
    if SUPABASE_REST_API_KEY:
        headers["apikey"] = SUPABASE_REST_API_KEY
        headers["Authorization"] = f"Bearer {SUPABASE_REST_API_KEY}"

    last_error: str = "unknown"
    for attempt in range(1, HEALTH_RETRY_ATTEMPTS + 1):
        try:
            async with httpx.AsyncClient(
                timeout=HEALTH_POSTGREST_TIMEOUT_SEC, follow_redirects=False
            ) as c:
                r = await c.get(SUPABASE_REST_URL, headers=headers)
                if r.status_code >= 500:
                    last_error = f"HTTP {r.status_code}"
                else:
                    return True, f"OK ({r.status_code})"
        except httpx.TimeoutException:
            last_error = f"timeout (>{HEALTH_POSTGREST_TIMEOUT_SEC}s)"
        except Exception as e:
            last_error = _normalize_network_error(e)

        if attempt < HEALTH_RETRY_ATTEMPTS:
            print(
                f"[health] PostgREST check attempt {attempt}/{HEALTH_RETRY_ATTEMPTS}: {last_error}"
            )
            await asyncio.sleep(HEALTH_RETRY_DELAY_SEC * attempt)

    return False, last_error


async def check_db() -> tuple[bool, str, int | None, int | None]:
    """Returns (ok, message, current_connections, max_connections)."""
    if not DATABASE_URL:
        return False, "DATABASE_URL not set", None, None
    last_error: Exception | None = None
    for attempt in range(1, HEALTH_RETRY_ATTEMPTS + 1):
        try:
            conn = await asyncpg.connect(DATABASE_URL, **_CONNECT_KWARGS)
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
            last_error = e
            print(
                f"[health] DB check attempt {attempt}/{HEALTH_RETRY_ATTEMPTS} error: "
                f"{type(e).__name__}: {repr(e)}"
            )
            if attempt < HEALTH_RETRY_ATTEMPTS and HEALTH_RETRY_DELAY_SEC > 0:
                await asyncio.sleep(HEALTH_RETRY_DELAY_SEC * attempt)

    if last_error is None:
        return False, "unknown DB error", None, None
    error_text = _normalize_network_error(last_error)
    return False, error_text, None, None


async def check_db_disk() -> int | None:
    """Return total bytes used by Main Postgres (DB + WAL), or None on error."""
    if not DATABASE_URL:
        return None
    try:
        conn = await asyncpg.connect(DATABASE_URL, **_CONNECT_KWARGS)
        try:
            db_bytes = await conn.fetchval("SELECT pg_database_size(current_database())") or 0
            try:
                wal_bytes = await conn.fetchval(
                    "SELECT coalesce(sum(size), 0)::bigint FROM pg_ls_waldir()"
                ) or 0
            except Exception:
                wal_bytes = 0
            return int(db_bytes) + int(wal_bytes)
        finally:
            await conn.close()
    except Exception as e:
        print(f"[health] check_db_disk error: {e}")
        return None


async def check_instantly_db() -> tuple[bool, str, int | None, int | None]:
    """Check Instantly DB connectivity. Returns (ok, message, connections, max)."""
    if not INSTANTLY_DATABASE_URL:
        return True, "not configured (skip)", None, None
    last_error: Exception | None = None
    for attempt in range(1, HEALTH_RETRY_ATTEMPTS + 1):
        try:
            conn = await asyncpg.connect(INSTANTLY_DATABASE_URL, **_CONNECT_KWARGS)
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
            last_error = e
            print(
                f"[health] Instantly DB check attempt {attempt}/{HEALTH_RETRY_ATTEMPTS} error: "
                f"{type(e).__name__}: {repr(e)}"
            )
            if attempt < HEALTH_RETRY_ATTEMPTS and HEALTH_RETRY_DELAY_SEC > 0:
                await asyncio.sleep(HEALTH_RETRY_DELAY_SEC * attempt)

    if last_error is None:
        return False, "unknown DB error", None, None
    return False, _normalize_network_error(last_error), None, None


async def check_proxy(proxy_url: str) -> tuple[bool, str]:
    """Check that a proxy can carry traffic.

    A proxy is ALIVE if any test request traverses it and comes back with a
    non-5xx HTTP response (2xx/3xx/4xx) — that proves bytes flowed through the
    proxy and returned. A 5xx is treated as the *target* being down, not the
    proxy, so we fall through to the next target before judging. The proxy is
    only DEAD when every target, across all retries, either fails at the
    transport layer (timeout / connection refused / DNS), returns 407 (proxy
    auth), or keeps returning 5xx — the latter only when ALL independent targets
    5xx through this proxy, which points at the proxy's own gateway rather than a
    single flaky target.
    """
    last_error: Exception | None = None
    last_http_status: int | None = None

    for attempt in range(1, HEALTH_RETRY_ATTEMPTS + 1):
        for test_url in PROXY_TEST_URLS:
            try:
                async with httpx.AsyncClient(
                    proxy=proxy_url,
                    timeout=HTTP_TIMEOUT,
                ) as c:
                    r = await c.get(test_url)
                # 407 = the proxy itself rejected our credentials → proxy fault.
                if r.status_code == 407:
                    last_http_status = 407
                    continue
                if r.status_code < 500:
                    return True, "OK"
                # 5xx — likely the target, not the proxy. Try the next target.
                last_http_status = r.status_code
            except Exception as e:
                last_error = e

        if attempt < HEALTH_RETRY_ATTEMPTS and HEALTH_RETRY_DELAY_SEC > 0:
            await asyncio.sleep(HEALTH_RETRY_DELAY_SEC * attempt)

    if last_error is not None:
        return False, _normalize_network_error(last_error, limit=80)
    if last_http_status == 407:
        return False, "HTTP 407 (proxy auth)"
    if last_http_status is not None:
        return False, f"HTTP {last_http_status} (target?)"
    return False, "unknown proxy error"


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
    last_error: str = "unknown"
    for attempt in range(1, HEALTH_RETRY_ATTEMPTS + 1):
        try:
            async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as c:
                r = await c.head(S3_ENDPOINT)
                if r.status_code < 500:
                    return True, f"OK ({r.status_code})"
                last_error = f"HTTP {r.status_code}"
        except httpx.TimeoutException:
            last_error = "timeout"
        except Exception as e:
            last_error = _normalize_network_error(e)

        if attempt < HEALTH_RETRY_ATTEMPTS:
            print(f"[health] S3 check attempt {attempt}/{HEALTH_RETRY_ATTEMPTS}: {last_error}")
            await asyncio.sleep(HEALTH_RETRY_DELAY_SEC * attempt)

    return False, last_error


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


async def check_container_resources() -> list[str]:
    """Warn when a container passes HEALTH_CONTAINER_USAGE_PCT of its own
    cgroup memory limit or CPU quota. Each warning is one line naming the
    container, its current usage, and its limit — so the operator can jump
    to `docker stats <name>` on the host immediately.

    Docker SDK calls are blocking, so we run the sync body in a worker
    thread to keep the event loop responsive. Containers without an explicit
    limit are skipped: reporting them against host RAM/CPU would drown out
    real signal from services we actually sized.
    """
    if HEALTH_CONTAINER_USAGE_PCT <= 0:
        return []
    try:
        import docker  # lazy import: bot must still boot without the socket
    except Exception as e:
        print(f"[health] docker sdk not available: {e}")
        return []

    def _sync() -> list[str]:
        warnings: list[str] = []
        try:
            client = docker.DockerClient(base_url=f"unix://{DOCKER_SOCK_PATH}", timeout=15)
        except Exception as e:
            print(f"[health] docker connect error: {e}")
            return warnings
        try:
            host_mem = int((client.info() or {}).get("MemTotal") or 0)
        except Exception:
            host_mem = 0
        try:
            containers = client.containers.list()
        except Exception as e:
            print(f"[health] docker list error: {e}")
            return warnings

        for c in containers:
            try:
                stats = c.stats(stream=False)
            except Exception:
                continue
            # ── Memory ────────────────────────────────────────────────────
            mem = stats.get("memory_stats") or {}
            usage = int(mem.get("usage") or 0)
            # Exclude ALL reclaimable page cache — inactive_file + active_file
            # на cgroup v2, cache на v1. Раньше вычитали только inactive_file и
            # получали ложные 90%-алерты у portal-backup после дампа: свежие
            # записи tar сидят в active_file несколько часов и не попадали под
            # вычет. postgres shared_buffers тоже уходит в active_file — так что
            # это заодно чинит и его false-positives.
            inner = mem.get("stats") or {}
            file_cache = int(inner.get("inactive_file") or 0) + int(inner.get("active_file") or 0)
            if file_cache == 0:
                file_cache = int(inner.get("cache") or 0)
            usage_real = max(0, usage - file_cache)
            limit = int(mem.get("limit") or 0)
            # Docker reports host RAM when no cgroup limit is set. Treat >=90%
            # of host RAM as "unlimited" and skip — otherwise every unlimited
            # container looks 80% loaded once the box gets moderately used.
            has_limit = limit > 0 and (host_mem == 0 or limit < host_mem * 0.9)
            if has_limit and usage_real > 0:
                pct = usage_real / limit * 100
                if pct >= HEALTH_CONTAINER_USAGE_PCT:
                    warnings.append(
                        f"🟡 <b>{c.name}</b> memory: "
                        f"{_fmt_bytes(usage_real)} / {_fmt_bytes(limit)} "
                        f"({pct:.0f}%)"
                    )
            # ── CPU ──────────────────────────────────────────────────────
            # precpu_stats is the previous internal sample kept by dockerd, so
            # a single /stats?stream=false call already carries a valid delta
            # for long-running containers. First-frame case (delta<=0) is
            # skipped, so a freshly-started container won't false-alarm.
            cpu = stats.get("cpu_stats") or {}
            pre = stats.get("precpu_stats") or {}
            cur_total = int((cpu.get("cpu_usage") or {}).get("total_usage") or 0)
            pre_total = int((pre.get("cpu_usage") or {}).get("total_usage") or 0)
            cur_sys = int(cpu.get("system_cpu_usage") or 0)
            pre_sys = int(pre.get("system_cpu_usage") or 0)
            online = int(cpu.get("online_cpus") or 0)
            cpu_delta = cur_total - pre_total
            sys_delta = cur_sys - pre_sys
            if cpu_delta <= 0 or sys_delta <= 0 or online <= 0:
                continue
            cores_used = cpu_delta / sys_delta * online  # e.g. 1.4 = 140% of 1 core
            cpu_limit_cores: float | None = None
            try:
                host_cfg = c.attrs.get("HostConfig") or {}
                quota = int(host_cfg.get("CpuQuota") or 0)
                period = int(host_cfg.get("CpuPeriod") or 100000)
                if quota > 0 and period > 0:
                    cpu_limit_cores = quota / period
            except Exception:
                pass
            if cpu_limit_cores and cpu_limit_cores > 0:
                pct = cores_used / cpu_limit_cores * 100
                if pct >= HEALTH_CONTAINER_USAGE_PCT:
                    warnings.append(
                        f"🟡 <b>{c.name}</b> CPU: "
                        f"{cores_used:.2f} / {cpu_limit_cores:.1f} cores "
                        f"({pct:.0f}%)"
                    )
        return warnings

    try:
        result = await asyncio.to_thread(_sync)
    except Exception as e:
        print(f"[health] container check error: {e}")
        return []
    if not result:
        return []
    result.insert(
        0,
        f"🟡 <b>Контейнеры на проде выше {HEALTH_CONTAINER_USAGE_PCT}% лимита</b>",
    )
    result.append("Зайди на 139 и проверь: <code>docker stats --no-stream</code>")
    return result


def _healthcheck_hint(last_output: str) -> str:
    """Return a short probable-cause hint for a healthcheck failure log line."""
    if not last_output:
        return ""
    lo = last_output.lower()
    if "no such file" in lo and "/bin/sh" in lo:
        return (
            "\n💡 <b>Причина:</b> образ distroless — в нём нет /bin/sh, тест "
            "не может запуститься.\n"
            "<b>Фикс:</b> в compose поставить <code>healthcheck: disable: true</code> "
            "и <code>docker compose up -d --force-recreate &lt;service&gt;</code>."
        )
    if "no such file" in lo:
        return (
            "\n💡 <b>Причина:</b> утилита из теста отсутствует в образе (curl/wget/nc не установлены).\n"
            "<b>Фикс:</b> заменить тест на встроенный бинарь или ставить утилиту в Dockerfile."
        )
    if "connection refused" in lo:
        return (
            "\n💡 <b>Вероятная причина:</b> healthcheck идёт на <code>localhost</code>, "
            "который резолвится в IPv6 (::1), а сервис слушает только IPv4 (0.0.0.0).\n"
            "<b>Фикс:</b> в тесте заменить <code>localhost</code> → <code>127.0.0.1</code>. "
            "После правки compose нужен <code>--force-recreate</code>."
        )
    if "timeout" in lo or "timed out" in lo:
        return (
            "\n💡 <b>Возможные причины:</b> сервис отвечает медленно или в стрессе. "
            "Поднять <code>timeout</code>/<code>start_period</code> в healthcheck, "
            "проверить нагрузку и логи сервиса."
        )
    if "404" in lo or "not found" in lo:
        return (
            "\n💡 <b>Причина:</b> endpoint отсутствует. Поменяй путь в тесте "
            "(например, <code>/health</code> → <code>/status</code>) — актуальный "
            "путь смотри в документации образа."
        )
    return ""


async def check_container_healthchecks() -> list[str]:
    """Warn about containers whose healthcheck is stuck failing (broken test)
    or whose pids usage nears the cgroup limit (fork-bomb risk).

    Runs on the same 15-min health cycle as the rest. Alerts are deduped per
    (container_id, created_at) — one message per broken container per lifetime.
    Recreating the container clears the dedup key, so a genuine re-alert fires
    after a force-recreate that didn't actually fix the root cause.
    """
    if HEALTH_CONTAINER_FAILING_STREAK <= 0 and HEALTH_CONTAINER_PIDS_PCT <= 0:
        return []
    try:
        import docker  # lazy import — bot must still boot without the socket
    except Exception as e:
        print(f"[health] docker sdk not available: {e}")
        return []

    def _sync() -> list[str]:
        warnings: list[str] = []
        try:
            client = docker.DockerClient(base_url=f"unix://{DOCKER_SOCK_PATH}", timeout=15)
        except Exception as e:
            print(f"[health] docker connect error: {e}")
            return warnings
        try:
            containers = client.containers.list()
        except Exception as e:
            print(f"[health] docker list error: {e}")
            return warnings

        seen_keys: set[str] = set()
        for c in containers:
            try:
                attrs = c.attrs
            except Exception:
                continue

            state = attrs.get("State") or {}
            health = state.get("Health") or {}
            streak = int(health.get("FailingStreak") or 0)
            hc_status = (health.get("Status") or "").lower()
            created_at = attrs.get("Created", "")
            dedup_key = f"{c.id}:{created_at}"
            seen_keys.add(dedup_key)

            # ── Broken healthcheck ────────────────────────────────────────
            # Both conditions needed: streak >= threshold AND Health.Status
            # is "unhealthy". A container inside its start_period may show
            # a big FailingStreak but still resolve — we wait for docker to
            # decide before alerting.
            if (
                HEALTH_CONTAINER_FAILING_STREAK > 0
                and streak >= HEALTH_CONTAINER_FAILING_STREAK
                and hc_status == "unhealthy"
                and dedup_key not in _CONTAINER_HEALTH_ALERTED
            ):
                _CONTAINER_HEALTH_ALERTED.add(dedup_key)
                log = health.get("Log") or []
                last_output = ""
                if log:
                    last_output = (log[-1].get("Output") or "").strip()
                last_snippet = last_output.replace("\n", " ")[:300] or "no log"

                hc = (attrs.get("Config") or {}).get("Healthcheck") or {}
                test_list = hc.get("Test") or []
                if isinstance(test_list, list):
                    test_str = " ".join(str(x) for x in test_list)[:200]
                else:
                    test_str = str(test_list)[:200]

                image = (attrs.get("Config") or {}).get("Image", "?")
                hint = _healthcheck_hint(last_output)

                warnings.append(
                    f"🟠 <b>{c.name}</b> — сломан healthcheck "
                    f"(провалов подряд: {streak})\n"
                    f"Образ: <code>{image}</code>\n"
                    f"Тест: <code>{test_str or 'not defined'}</code>\n"
                    f"Последняя ошибка: <code>{last_snippet}</code>"
                    f"{hint}"
                )

            # ── Pids usage nearing limit ─────────────────────────────────
            if HEALTH_CONTAINER_PIDS_PCT > 0:
                try:
                    stats = c.stats(stream=False)
                    pids = stats.get("pids_stats") or {}
                    current = int(pids.get("current") or 0)
                    limit = int(pids.get("limit") or 0)
                except Exception:
                    current, limit = 0, 0
                if limit > 0 and current > 0:
                    pct = current / limit * 100
                    if pct >= HEALTH_CONTAINER_PIDS_PCT:
                        warnings.append(
                            f"🟡 <b>{c.name}</b> pids: {current} / {limit} ({pct:.0f}%) "
                            f"— близко к cgroup-лимиту, возможен fork-loop"
                        )

        # Prune dedup keys for containers that no longer exist so the set
        # doesn't accumulate indefinitely (recreate → new key → re-alert).
        stale = [k for k in _CONTAINER_HEALTH_ALERTED if k not in seen_keys]
        for k in stale:
            _CONTAINER_HEALTH_ALERTED.discard(k)

        return warnings

    try:
        result = await asyncio.to_thread(_sync)
    except Exception as e:
        print(f"[health] container healthcheck check error: {e}")
        return []
    if not result:
        return []
    result.insert(
        0,
        "⚠️ <b>Проблемы контейнеров: healthcheck / pids</b>",
    )
    result.append(
        "На 139 глянь <code>docker ps --filter health=unhealthy</code> "
        "и <code>docker inspect &lt;name&gt;</code>."
    )
    return result


# ── Consecutive-failure tracking ─────────────────────────────────────────────

def _track(key: str, failed: bool) -> tuple[bool, bool]:
    """Update consecutive-failure counter for *key*.

    Returns ``(emit_alert, emit_recovery)``:
    - ``emit_alert`` — True the first time failures reach HEALTH_ALERT_MIN_CONSECUTIVE,
      then again every HEALTH_ALERT_REPEAT_CYCLES additional failures (if configured).
    - ``emit_recovery`` — True on the first success after a sustained failure.
    """
    prev = _FAIL_COUNT.get(key, 0)
    if failed:
        count = prev + 1
        _FAIL_COUNT[key] = count
        if count == HEALTH_ALERT_MIN_CONSECUTIVE:
            return True, False  # threshold just reached
        if (
            HEALTH_ALERT_REPEAT_CYCLES > 0
            and count > HEALTH_ALERT_MIN_CONSECUTIVE
            and (count - HEALTH_ALERT_MIN_CONSECUTIVE) % HEALTH_ALERT_REPEAT_CYCLES == 0
        ):
            return True, False  # periodic re-alert
        return False, False
    else:
        _FAIL_COUNT[key] = 0
        return False, prev >= HEALTH_ALERT_MIN_CONSECUTIVE  # recovery


# ── Parser-job monitoring ────────────────────────────────────────────────────
#
# One registry covers user-facing parsers and processing tools. Every five
# minutes we look for:
#   1) an active job whose DB heartbeat/progress has not moved for
#      JOB_STUCK_MINUTES (20 min — see the constant for why not 15);
#   2) a newly failed job with a real error.
#
# Alerts are claimed in health_check_job_alerts, so a container restart or the
# next polling cycle cannot repeat the same message. Explicit stopped/cancelled
# statuses are not failures; legacy jobs that encode a manual stop as
# status=failed are filtered by the error text.


@dataclass(frozen=True)
class JobMonitorSpec:
    table: str
    label: str
    active_statuses: tuple[str, ...]
    progress_columns: tuple[str, ...]
    log_hint: str
    owner_column: str | None = "user_id"
    updated_column: str | None = None
    started_column: str | None = "started_at"
    queue_heartbeat_column: str | None = None
    extra_predicate: str | None = None
    progress_sql: str | None = None
    failed_statuses: tuple[str, ...] = (
        "failed", "error", "captcha", "blocked", "timeout", "login_required",
    )


_JOB_MONITOR_SPECS: tuple[JobMonitorSpec, ...] = (
    JobMonitorSpec(
        "parser_jobs", "HH / ENG Hiring", ("pending", "running"),
        ("total_found", "total_parsed", "progress_stage", "progress_percent", "progress_detail"),
        "portal-worker-hh / portal-worker-eng-hiring",
        # Permanent archive parent rows are not executable worker jobs.
        extra_predicate="j.parser_type <> 'hh_vacancies_autopipeline'",
    ),
    JobMonitorSpec(
        "search_parser_jobs", "Поисковый парсер", ("pending", "running"),
        ("total_queries", "processed_queries", "total_results", "progress_stage", "progress_percent"),
        "portal-worker-search",
    ),
    JobMonitorSpec(
        "website_enrichment_jobs", "Поиск почт / обогащение", ("preparing", "pending", "running"),
        ("total", "processed", "success_count", "error_count", "preparing_heartbeat_at"),
        "portal-worker-enrich", queue_heartbeat_column="preparing_heartbeat_at",
    ),
    JobMonitorSpec(
        "email_validation_jobs", "Валидация почт", ("pending", "running"),
        ("total", "processed", "success_count", "error_count"),
        "portal-worker-emailvalidation",
    ),
    JobMonitorSpec(
        "inn_enrich_jobs", "Обогащение по ИНН", ("pending", "running"),
        ("total", "processed"),
        "portal-worker-inn-enrich",
    ),
    JobMonitorSpec(
        "brief_scoring_jobs", "Оценка ЦА", ("pending", "running"),
        ("total", "processed", "success_count", "error_count"),
        "portal-worker-enrich",
    ),
    JobMonitorSpec(
        "base_constructor_jobs", "Конструктор баз", ("pending", "processing"),
        ("current_step", "current_step_key", "current_step_progress", "total_steps"),
        "portal-worker-baseconstructor", updated_column="started_at", started_column=None,
    ),
    JobMonitorSpec(
        "yandex_maps_jobs", "Яндекс.Карты", ("pending", "running"),
        ("progress_stage", "total_links", "processed_links", "total_organizations", "processed_organizations"),
        "portal-worker-yandexmaps", updated_column="updated_at",
    ),
    JobMonitorSpec(
        "yandex_direct_jobs", "Яндекс.Директ", ("pending", "running"),
        ("total_requests", "processed_requests", "found_advertisers", "saved_total", "errors_count"),
        "portal-worker-hh", updated_column="updated_at",
    ),
    JobMonitorSpec(
        "google_maps_jobs", "Google Maps", ("queued", "running"),
        ("message", "total_targets", "processed_targets", "total_results"),
        "portal-worker-googleparsers",
    ),
    JobMonitorSpec(
        "google_news_jobs", "Google News", ("queued", "running"),
        ("message", "total_targets", "processed_targets", "total_results"),
        "portal-worker-googleparsers",
    ),
    JobMonitorSpec(
        "crypto_payment_jobs", "Криптоплатежи", ("pending", "running"),
        ("checked_count", "total_count"), "portal-worker-enrich", updated_column="updated_at",
        started_column=None,
    ),
    JobMonitorSpec(
        "hh_archive_jobs", "Архив HH", ("pending", "running"),
        ("found_total", "saved_total", "processed_chunks", "total_chunks", "errors_count"),
        "portal-worker-hh", updated_column="updated_at",
    ),
    JobMonitorSpec(
        "lead_import_jobs", "Импорт / парсинг лидов", ("pending", "running"),
        ("total_rows", "processed_rows", "enrichment_progress"), "portal-worker-enrich",
    ),
    JobMonitorSpec(
        "lpr_jobs", "LPR Discovery", ("pending", "running"),
        ("total_found", "enriched_count", "usable_count", "apollo_credits", "pdl_credits"),
        "portal",
    ),
    JobMonitorSpec(
        "dfyb_jobs", "DFYB", ("planning", "parsing", "processing"),
        ("current_step", "current_step_name", "current_step_progress", "total_steps"),
        "portal",
    ),
    JobMonitorSpec(
        "reputation_jobs", "Парсер репутации", ("pending", "running"),
        ("progress_stage", "total_candidates", "processed_candidates", "auto_export_count"),
        "portal",
    ),
    JobMonitorSpec(
        "large_score_jobs", "Большой скоринг", ("pending", "uploading", "parsing", "scoring"),
        ("total_domains", "parsed_domains", "scored_domains", "active_domains"),
        "portal-worker-bob-scorer", owner_column="client_user_id",
        updated_column="updated_at", started_column=None,
    ),
    JobMonitorSpec(
        # found_count/progress_note/progress_at обязательны в этом списке:
        # stop_reason и result_users заполняются только в самом конце задачи, и
        # по ним любой обход длиннее 15 минут выглядел зависшим. 10.08.2026 это
        # дало ложную тревогу на живой задаче, которая нормально работала.
        "tg_parser_jobs", "Telegram-парсер", ("pending", "running"),
        ("found_count", "progress_note", "progress_at", "stop_reason", "result_users"),
        "portal-worker-tg-parser",
    ),
    JobMonitorSpec(
        "tg_scan_jobs", "Telegram-сканер", ("pending", "running"),
        ("scanned", "videos_found", "completed", "errors"),
        "portal-worker-tg-transcribe", updated_column="updated_at",
    ),
    JobMonitorSpec(
        "tg_transcribe_jobs", "Telegram-транскрибация", ("pending", "running"),
        ("payload",), "portal-worker-tg-transcribe", updated_column="updated_at",
        owner_column=None,
        progress_sql=(
            "concat_ws(' | ', "
            "j.payload #>> '{videoInfo,filename}', "
            "j.payload #>> '{monitor_progress,stage}', "
            "(j.payload #>> '{monitor_progress,progress_percent}') || '%')"
        ),
    ),
)

# table:id -> (progress fingerprint, loop-clock time when it last changed)
_JOB_PROGRESS_TRACKER: dict[str, tuple[str, float]] = {}
_JOB_FAILURE_BASELINE_KEY = "job-monitor:v1:initialized"


def _is_manual_stop_error(error_message: str | None) -> bool:
    msg = (error_message or "").strip().lower()
    if not msg:
        return False
    markers = (
        "остановлено пользователем",
        "остановлена пользователем",
        "остановлен пользователем",
        "остановлено вручную",
        "stopped by user",
        "cancelled by user",
        "canceled by user",
        "job cancelled",
        "job canceled",
    )
    return any(marker in msg for marker in markers) or msg == "остановлено"


def _job_owner(row) -> str:
    return str(row["owner_name"] or row["owner_email"] or "системная задача")


def _job_context(spec: JobMonitorSpec, row) -> str:
    owner = html.escape(_job_owner(row))
    job_id = html.escape(str(row["id"])[:8])
    log_commands = " / ".join(
        f"<code>docker logs {html.escape(container.strip())} --tail 200</code>"
        for container in spec.log_hint.split(" / ")
    )
    return (
        f"{owner} · <code>#{job_id}</code>\n"
        f"Проверьте логи: {log_commands}"
    )


async def _claim_job_alert(conn, alert_key: str) -> bool:
    row = await conn.fetchrow(
        f"INSERT INTO {JOB_ALERTS_TABLE} (alert_key) VALUES ($1) "
        "ON CONFLICT (alert_key) DO NOTHING RETURNING alert_key",
        alert_key,
    )
    return row is not None


def _progress_sql(spec: JobMonitorSpec) -> str:
    if spec.progress_sql:
        return spec.progress_sql
    values = ", ".join(
        f"coalesce(j.{column}::text, '')" for column in spec.progress_columns
    )
    return f"concat_ws('|', {values})"


async def _fetch_active_job_rows(conn, spec: JobMonitorSpec):
    start_anchor = (
        f"coalesce(j.{spec.started_column}, j.created_at)"
        if spec.started_column
        else "j.created_at"
    )
    if spec.updated_column:
        activity_secs = (
            f"extract(epoch FROM (now() - coalesce(j.{spec.updated_column}, "
            f"{start_anchor})))::int"
        )
    else:
        activity_secs = "NULL::int"
    queue_anchor = (
        f"coalesce(j.{spec.queue_heartbeat_column}, j.created_at)"
        if spec.queue_heartbeat_column
        else "j.created_at"
    )
    owner_select = (
        "p.full_name AS owner_name, p.email AS owner_email"
        if spec.owner_column
        else "NULL::text AS owner_name, NULL::text AS owner_email"
    )
    owner_join = (
        f"LEFT JOIN public.profiles p ON p.id = j.{spec.owner_column}"
        if spec.owner_column
        else ""
    )
    extra_filter = f" AND ({spec.extra_predicate})" if spec.extra_predicate else ""
    return await conn.fetch(
        f"SELECT j.id::text AS id, j.status, {_progress_sql(spec)} AS progress, "
        f"  {activity_secs} AS activity_secs, "
        f"  extract(epoch FROM (now() - {start_anchor}))::int AS active_secs, "
        f"  extract(epoch FROM (now() - {queue_anchor}))::int AS age_secs, "
        f"  {owner_select} "
        f"FROM public.{spec.table} j "
        f"{owner_join} "
        "WHERE j.status = ANY($1::text[])"
        f"{extra_filter}",
        list(spec.active_statuses),
    )


async def check_stuck_jobs() -> list[str]:
    """Return one alert per parser job with no DB progress for JOB_STUCK_MINUTES."""
    if not DATABASE_URL:
        return []
    loop_now = asyncio.get_running_loop().time()
    problems: list[str] = []
    seen_keys: set[str] = set()

    try:
        conn = await asyncpg.connect(DATABASE_URL, **_CONNECT_KWARGS)
    except Exception as e:
        print(f"[health] stuck-jobs connect error: {_normalize_network_error(e)}")
        return []
    try:
        deferred_emailval_jobs: set[str] = set()
        try:
            drows = await conn.fetch(
                "SELECT DISTINCT job_id::text AS job_id "
                "FROM public.email_validation_queue "
                "WHERE status = 'pending' AND retry_after > now()"
            )
            deferred_emailval_jobs = {r["job_id"] for r in drows}
        except Exception as e:
            print(f"[health] email-validation deferred query skipped: {e}")

        for spec in _JOB_MONITOR_SPECS:
            try:
                rows = await _fetch_active_job_rows(conn, spec)
            except Exception as e:
                print(f"[health] stuck-jobs query {spec.table} skipped: {e}")
                continue

            for row in rows:
                key = f"{spec.table}:{row['id']}"
                seen_keys.add(key)
                status = str(row["status"])
                stalled_secs: int | None = None

                # Queue/preparation states have no meaningful progress yet:
                # created_at is the heartbeat and JOB_STUCK_MINUTES is enough.
                if status in ("pending", "queued", "preparing", "planning", "uploading"):
                    stalled_secs = int(row["age_secs"] or 0)
                elif spec.updated_column:
                    # Tables with updated_at expose an exact DB heartbeat.
                    stalled_secs = int(row["activity_secs"] or 0)
                else:
                    # Other tables are observed externally. Any changed progress
                    # field resets the timer; an unchanged fingerprint starts it.
                    fingerprint = str(row["progress"] or "")
                    previous = _JOB_PROGRESS_TRACKER.get(key)
                    if previous is None or previous[0] != fingerprint:
                        _JOB_PROGRESS_TRACKER[key] = (fingerprint, loop_now)
                    else:
                        stalled_secs = int(loop_now - previous[1])

                if stalled_secs is None or stalled_secs < JOB_STUCK_MINUTES * 60:
                    continue
                if spec.table == "email_validation_jobs" and row["id"] in deferred_emailval_jobs:
                    _JOB_PROGRESS_TRACKER[key] = (str(row["progress"] or ""), loop_now)
                    continue

                alert_key = f"stuck:{key}"
                if not await _claim_job_alert(conn, alert_key):
                    continue
                progress = html.escape(str(row["progress"] or "нет данных")[:180])
                problems.append(
                    f"🟠 <b>Долго висит: {html.escape(spec.label)}</b>\n"
                    f"Нет обновлений {stalled_secs // 60} мин · статус <code>{html.escape(status)}</code>\n"
                    f"Прогресс: <code>{progress}</code>\n"
                    f"{_job_context(spec, row)}"
                )
    finally:
        await conn.close()

    for key in list(_JOB_PROGRESS_TRACKER):
        if key not in seen_keys:
            _JOB_PROGRESS_TRACKER.pop(key, None)
    return problems


async def _baseline_existing_failures(conn) -> bool:
    """Mark pre-deploy failures as seen. Returns True after baseline exists."""
    exists = await conn.fetchval(
        f"SELECT 1 FROM {JOB_ALERTS_TABLE} WHERE alert_key = $1",
        _JOB_FAILURE_BASELINE_KEY,
    )
    if exists:
        return True
    for spec in _JOB_MONITOR_SPECS:
        try:
            extra_filter = f" AND ({spec.extra_predicate})" if spec.extra_predicate else ""
            rows = await conn.fetch(
                f"SELECT j.id::text AS id FROM public.{spec.table} j "
                "WHERE j.status = ANY($1::text[])"
                f"{extra_filter}",
                list(spec.failed_statuses),
            )
            if rows:
                await conn.executemany(
                    f"INSERT INTO {JOB_ALERTS_TABLE} (alert_key) VALUES ($1) "
                    "ON CONFLICT (alert_key) DO NOTHING",
                    [(f"failed:{spec.table}:{row['id']}",) for row in rows],
                )
        except Exception as e:
            print(f"[health] failed-jobs baseline {spec.table} skipped: {e}")
    await conn.execute(
        f"INSERT INTO {JOB_ALERTS_TABLE} (alert_key) VALUES ($1) "
        "ON CONFLICT (alert_key) DO NOTHING",
        _JOB_FAILURE_BASELINE_KEY,
    )
    return False


async def check_failed_jobs() -> list[str]:
    """Return alerts for new parser failures that contain a real error."""
    if not DATABASE_URL:
        return []
    problems: list[str] = []
    try:
        conn = await asyncpg.connect(DATABASE_URL, **_CONNECT_KWARGS)
    except Exception as e:
        print(f"[health] failed-jobs connect error: {_normalize_network_error(e)}")
        return []
    try:
        if not await _baseline_existing_failures(conn):
            print("[health] failed-jobs baseline initialized")
            return []

        for spec in _JOB_MONITOR_SPECS:
            owner_select = (
                "p.full_name AS owner_name, p.email AS owner_email"
                if spec.owner_column
                else "NULL::text AS owner_name, NULL::text AS owner_email"
            )
            owner_join = (
                f"LEFT JOIN public.profiles p ON p.id = j.{spec.owner_column}"
                if spec.owner_column
                else ""
            )
            extra_filter = f" AND ({spec.extra_predicate})" if spec.extra_predicate else ""
            try:
                rows = await conn.fetch(
                    "SELECT j.id::text AS id, j.status, j.error_message, "
                    f"  {owner_select} "
                    f"FROM public.{spec.table} j "
                    f"{owner_join} "
                    "WHERE j.status = ANY($1::text[]) "
                    "  AND nullif(btrim(j.error_message), '') IS NOT NULL"
                    f"{extra_filter}",
                    list(spec.failed_statuses),
                )
            except Exception as e:
                print(f"[health] failed-jobs query {spec.table} skipped: {e}")
                continue

            for row in rows:
                error_message = str(row["error_message"] or "")
                if _is_manual_stop_error(error_message):
                    continue
                alert_key = f"failed:{spec.table}:{row['id']}"
                if not await _claim_job_alert(conn, alert_key):
                    continue
                error_text = html.escape(error_message[:500])
                problems.append(
                    f"🔴 <b>Ошибка парсера: {html.escape(spec.label)}</b>\n"
                    f"Статус: <code>{html.escape(str(row['status']))}</code>\n"
                    f"Ошибка: <code>{error_text}</code>\n"
                    f"{_job_context(spec, row)}"
                )
    finally:
        await conn.close()
    return problems


# ── Суточные пайплайны: OutreachOS и Mailganer auto-pipeline ────────────────
#
# Отдельный монитор от парсеров: здесь важна не очередь джобов, а суточный цикл.
# Для каждого пайплайна ловим четыре состояния: завис/упал/не стартовал/OK-стат.
# Дедуп алертов — через JOB_ALERTS_TABLE (переживает рестарт контейнера).

_AUTOPIPE_FAILURE_BASELINE_KEY = "pipeline-monitor:v1:initialized"


def _msk(ts) -> str:
    if ts is None:
        return "—"
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts.astimezone(timezone(timedelta(hours=3))).strftime("%d.%m %H:%M МСК")


async def _check_outreachos_pipeline(conn) -> list[str]:
    """Монитор outreachos_pipeline_runs (крон 02:00 UTC ежедневно)."""
    problems: list[str] = []
    try:
        rows = await conn.fetch(
            "SELECT id::text AS id, status, parsed, new_employers, valid_contacts, "
            "       appended, appended_b, error_message, started_at, finished_at "
            "FROM public.outreachos_pipeline_runs "
            "WHERE started_at >= now() - interval '36 hours' "
            "ORDER BY started_at DESC"
        )
    except Exception as e:
        print(f"[health] outreachos-pipeline query skipped: {e}")
        return []

    now = datetime.now(timezone.utc)
    today = now.date()
    log_hint = (
        "Проверьте логи: <code>tail -100 /var/log/portal/outreachos-cron.log</code> · "
        "<code>docker logs portal-worker-hh --tail 100</code>"
    )

    started_today = False
    for row in rows:
        started = row["started_at"]
        if started.tzinfo is None:
            started = started.replace(tzinfo=timezone.utc)
        if started.date() == today:
            started_today = True
        age_min = int((now - started).total_seconds() // 60)
        status = str(row["status"])
        run_no = f"#{str(row['id'])[:8]}"

        if status == "running" and age_min >= OUTREACHOS_STUCK_MINUTES:
            if not await _claim_job_alert(conn, f"outreachos:stuck:{row['id']}"):
                continue
            problems.append(
                f"🔴 <b>OutreachOS: прогон завис {run_no}</b>\n"
                f"Старт {_msk(started)}, статус <code>running</code> уже {age_min // 60}ч {age_min % 60}м "
                f"(порог {OUTREACHOS_STUCK_MINUTES}м). Лог молчит — процесс, скорее всего, умер, "
                f"а строка в БД осталась «running».\n"
                f"{log_hint}"
            )
        elif status == "failed":
            if not await _claim_job_alert(conn, f"outreachos:failed:{row['id']}"):
                continue
            error_text = html.escape(str(row["error_message"] or "без текста ошибки")[:400])
            problems.append(
                f"🔴 <b>OutreachOS: прогон упал {run_no}</b>\n"
                f"Старт {_msk(started)}, финиш {_msk(row['finished_at'])}\n"
                f"Ошибка: <code>{error_text}</code>\n"
                f"{log_hint}"
            )
        elif status == "completed" and started.date() == today:
            # Дневной OK-стат: чтобы по одному сообщению было видно, что прогон
            # прошёл и сколько залил (без него «тихий» день неотличим от тихой поломки).
            if not await _claim_job_alert(conn, f"outreachos:ok:{row['id']}"):
                continue
            a, b = int(row["appended"] or 0), int(row["appended_b"] or 0)
            problems.append(
                f"🟢 <b>OutreachOS: прогон завершён {run_no}</b>\n"
                f"parsed={row['parsed']} · новых компаний={row['new_employers']} · "
                f"валидных контактов={row['valid_contacts']} · залито A={a} B={b} (всего {a + b})"
            )

    # Крон не отработал сегодня вообще.
    if (
        not started_today
        and now.hour >= OUTREACHOS_MISSING_AFTER_UTC_HOUR
        and await _claim_job_alert(conn, f"outreachos:missing:{today.isoformat()}")
    ):
        problems.append(
            f"🟠 <b>OutreachOS: сегодняшний прогон не стартовал</b>\n"
            f"Крон 02:00 UTC (05:00 МСК) не оставил строки в outreachos_pipeline_runs за сегодня. "
            f"Проверьте crontab и докер: <code>crontab -l | grep outreachos</code> · {log_hint}"
        )

    return problems


async def _baseline_autopipe_failures(conn) -> bool:
    """Пометить исторические failed-прогоны как виденные (один раз после деплоя)."""
    exists = await conn.fetchval(
        f"SELECT 1 FROM {JOB_ALERTS_TABLE} WHERE alert_key = $1",
        _AUTOPIPE_FAILURE_BASELINE_KEY,
    )
    if exists:
        return True
    rows = await conn.fetch(
        "SELECT id::text AS id FROM public.client_auto_pipeline_runs WHERE status = 'failed'"
    )
    if rows:
        await conn.executemany(
            f"INSERT INTO {JOB_ALERTS_TABLE} (alert_key) VALUES ($1) "
            "ON CONFLICT (alert_key) DO NOTHING",
            [(f"autopipeline:failed:{row['id']}",) for row in rows],
        )
    await conn.execute(
        f"INSERT INTO {JOB_ALERTS_TABLE} (alert_key) VALUES ($1) "
        "ON CONFLICT (alert_key) DO NOTHING",
        _AUTOPIPE_FAILURE_BASELINE_KEY,
    )
    return False


async def _check_autopipeline(conn) -> list[str]:
    """Монитор client_auto_pipeline_runs (Mailganer: HH → скоринг → маршрутизация)."""
    problems: list[str] = []
    try:
        if not await _baseline_autopipe_failures(conn):
            print("[health] autopipeline failures baseline initialized")
            return []
        rows = await conn.fetch(
            "SELECT r.id::text AS id, r.status, r.parsed_count, r.new_count, "
            "       r.routed_count, r.stored_count, r.failed_count, r.error_message, "
            "       r.started_at, r.finished_at, r.heartbeat_at, "
            "       coalesce(p.full_name, p.email, r.client_user_id::text) AS owner "
            "FROM public.client_auto_pipeline_runs r "
            "LEFT JOIN public.profiles p ON p.id = r.client_user_id "
            "WHERE r.started_at >= now() - interval '36 hours' "
            "ORDER BY r.started_at DESC"
        )
    except Exception as e:
        print(f"[health] autopipeline query skipped: {e}")
        return []

    now = datetime.now(timezone.utc)
    log_hint = "Проверьте логи: <code>docker logs portal-worker-autopipeline --tail 100</code>"

    for row in rows:
        status = str(row["status"])
        owner = html.escape(str(row["owner"] or "клиент"))
        run_no = f"#{str(row['id'])[:8]}"

        if status == "failed":
            error_message = str(row["error_message"] or "")
            if _is_manual_stop_error(error_message):
                continue
            if not await _claim_job_alert(conn, f"autopipeline:failed:{row['id']}"):
                continue
            problems.append(
                f"🔴 <b>Mailganer auto-pipeline: прогон упал {run_no}</b>\n"
                f"{owner} · старт {_msk(row['started_at'])}\n"
                f"Ошибка: <code>{html.escape(error_message[:400] or 'без текста')}</code>\n"
                f"{log_hint}"
            )
            continue

        # Активный прогон: heartbeat (или старт, если heartbeat ещё не было) не
        # должен замирать дольше порога.
        if status in ("completed",):
            continue
        heartbeat = row["heartbeat_at"] or row["started_at"]
        if heartbeat is None:
            continue
        if heartbeat.tzinfo is None:
            heartbeat = heartbeat.replace(tzinfo=timezone.utc)
        stale_min = int((now - heartbeat).total_seconds() // 60)
        if stale_min < AUTOPIPELINE_STUCK_MINUTES:
            continue
        if not await _claim_job_alert(conn, f"autopipeline:stuck:{row['id']}"):
            continue
        problems.append(
            f"🟠 <b>Mailganer auto-pipeline: прогон завис {run_no}</b>\n"
            f"{owner} · статус <code>{html.escape(status)}</code> · "
            f"нет heartbeat {stale_min}м (порог {AUTOPIPELINE_STUCK_MINUTES}м)\n"
            f"Прогресс: parsed={row['parsed_count']} new={row['new_count']} "
            f"routed={row['routed_count']} stored={row['stored_count']} failed={row['failed_count']}\n"
            f"{log_hint}"
        )

    return problems


async def check_pipeline_runs() -> list[str]:
    """Монитор суточных пайплайнов (OutreachOS + Mailganer) — см. run_job_monitor."""
    if not DATABASE_URL:
        return []
    try:
        conn = await asyncpg.connect(DATABASE_URL, **_CONNECT_KWARGS)
    except Exception as e:
        print(f"[health] pipeline-runs connect error: {_normalize_network_error(e)}")
        return []
    try:
        # Последовательно, НЕ gather: asyncpg-соединение не поддерживает
        # параллельные операции («another operation is in progress» — вторая
        # проверка молча пропускалась каждый тик, инцидент 06.08).
        out = await _check_outreachos_pipeline(conn)
        auto = await _check_autopipeline(conn)
        return [*out, *auto]
    finally:
        await conn.close()


async def run_job_monitor() -> None:
    """Run parser queue/failure checks independently from general health."""
    try:
        stuck, failed, pipelines = await asyncio.gather(
            check_stuck_jobs(),
            check_failed_jobs(),
            check_pipeline_runs(),
        )
        problems = [*pipelines, *stuck, *failed]
        if not problems:
            print(f"[health] job monitor OK at {_now_msk()}")
            return
        header = f"⚠️ <b>МОНИТОР ПАРСЕРОВ</b> — {_now_msk()}\n"
        await send_telegram(header + "\n" + "\n\n".join(problems))
        print(f"[health] JOB ALERT sent: {len(problems)} problem(s)")
    except Exception as e:
        print(f"[health] job monitor error: {_format_exception_message(e)}")


# ── Health check (every 15 min) ─────────────────────────────────────────────

HEALTH_CHECK_TIMEOUT_SEC = max(60, HEALTH_INTERVAL_SEC - 10)

async def _run_health_check_inner():
    """Check all services. Alert on sustained failures (>= HEALTH_ALERT_MIN_CONSECUTIVE)."""
    global LAST_HEALTH_CHECK_TS, LAST_PROXY_CHECK_TS
    loop_now = asyncio.get_running_loop().time()
    LAST_HEALTH_CHECK_TS = loop_now
    problems: list[str] = []
    recoveries: list[str] = []

    def _check(key: str, failed: bool, problem_text: str, recovery_text: str) -> None:
        emit_alert, emit_recovery = _track(key, failed)
        count = _FAIL_COUNT.get(key, 0)
        suffix = f" (×{count})" if failed and count > HEALTH_ALERT_MIN_CONSECUTIVE else ""
        if emit_alert:
            problems.append(problem_text + suffix)
        if emit_recovery:
            recoveries.append(recovery_text)

    site_ok, site_msg = await check_site()
    _check(
        "site", not site_ok,
        f"🔴 <b>Сайт</b> {PORTAL_URL}: {site_msg}",
        f"✅ <b>Сайт</b> {PORTAL_URL}: восстановлен",
    )

    if CRITICAL_ENDPOINTS:
        endpoint_results = await asyncio.gather(
            *(check_critical_endpoint(ep) for ep in CRITICAL_ENDPOINTS),
            return_exceptions=True,
        )
        endpoint_failures: list[str] = []
        for outcome in endpoint_results:
            if isinstance(outcome, Exception):
                endpoint_failures.append(f"  ✖ internal check error: {_normalize_network_error(outcome)}")
                continue
            ok, endpoint, msg = outcome
            if not ok:
                endpoint_failures.append(f"  ✖ {endpoint}: {msg}")
        _check(
            "endpoints", bool(endpoint_failures),
            "🔴 <b>Критичные endpoint'ы</b>:\n" + "\n".join(endpoint_failures),
            "✅ <b>Критичные endpoint'ы</b>: восстановлены",
        )

    postgrest_ok, postgrest_msg = await check_postgrest()
    _check(
        "postgrest", not postgrest_ok,
        f"🔴 <b>PostgREST</b> {SUPABASE_REST_URL}: {postgrest_msg}",
        f"✅ <b>PostgREST</b>: восстановлен",
    )

    db_ok, db_msg, db_cur, db_max = await check_db()
    _check(
        "db", not db_ok,
        f"🔴 <b>Main Postgres (35434)</b>: {db_msg}",
        "✅ <b>Main Postgres (35434)</b>: восстановлена",
    )
    if db_ok and db_cur is not None and db_max is not None:
        usage_pct = db_cur / db_max * 100
        if usage_pct > 80:
            problems.append(
                f"🟡 <b>Main Postgres connections</b>: {db_cur}/{db_max} ({usage_pct:.0f}%)"
            )

    if db_ok and DISK_TOTAL_GB > 0:
        disk_bytes = await check_db_disk()
        if disk_bytes is not None:
            disk_limit = DISK_TOTAL_GB * (1024 ** 3)
            disk_warn = DISK_WARN_GB * (1024 ** 3)
            disk_pct = disk_bytes / disk_limit * 100
            if disk_bytes >= disk_limit:
                problems.append(
                    f"🔴 <b>Main Postgres disk</b>: {_fmt_bytes(disk_bytes)} / "
                    f"{DISK_TOTAL_GB:g} GB ({disk_pct:.0f}%) — критический лимит!"
                )
            elif disk_bytes >= disk_warn:
                problems.append(
                    f"🟡 <b>Main Postgres disk</b>: {_fmt_bytes(disk_bytes)} / "
                    f"{DISK_TOTAL_GB:g} GB ({disk_pct:.0f}%)"
                )

    if INSTANTLY_DATABASE_URL:
        idb_ok, idb_msg, idb_cur, idb_max = await check_instantly_db()
        _check(
            "instantly_db", not idb_ok,
            f"🔴 <b>Instantly Postgres (35432)</b>: {idb_msg}",
            "✅ <b>Instantly Postgres (35432)</b>: восстановлена",
        )
        if idb_ok and idb_cur is not None and idb_max is not None:
            idb_pct = idb_cur / idb_max * 100
            if idb_pct > 80:
                problems.append(
                    f"🟡 <b>Instantly Postgres connections</b>: {idb_cur}/{idb_max} ({idb_pct:.0f}%)"
                )

    # Proxies run on a slower cadence than the rest of the cycle: the main check
    # fires every HEALTH_INTERVAL_SEC (~2 min) for site/DB, but proxies are only
    # probed every PROXY_CHECK_INTERVAL_SEC (~5 min). Skipping the proxy block on
    # the in-between cycles leaves the "proxies" failure counter untouched, so
    # the consecutive-failure / recovery logic still works across the gaps.
    if loop_now - LAST_PROXY_CHECK_TS >= PROXY_CHECK_INTERVAL_SEC:
        LAST_PROXY_CHECK_TS = loop_now
        proxy_results = await check_all_proxies()
        dead_proxies = [(g, addr, msg) for g, addr, ok, msg in proxy_results if not ok]
        if dead_proxies:
            total = len(ALL_PROXIES)
            alive = total - len(dead_proxies)
            lines = [f"🔴 <b>Прокси</b>: {alive}/{total} работают"]
            for g, addr, msg in dead_proxies:
                lines.append(f"  ✖ [{g}] {addr}: {msg}")
            proxy_problem = "\n".join(lines)
        else:
            proxy_problem = ""
        _check(
            "proxies", bool(dead_proxies),
            proxy_problem,
            "✅ <b>Прокси</b>: все работают",
        )

    s3_ok, s3_msg = await check_s3()
    _check(
        "s3", not s3_ok,
        f"🔴 <b>S3 хранилище</b>: {s3_msg}",
        "✅ <b>S3 хранилище</b>: восстановлено",
    )

    srv_ok, srv_msg = await check_server()
    _check(
        "server", not srv_ok,
        f"🔴 <b>Сервер {SERVER_IP}</b>: {srv_msg}",
        f"✅ <b>Сервер {SERVER_IP}</b>: восстановлен",
    )

    # Per-container memory/CPU watchdog. Added 23.07.2026 after main-rest OOM
    # (512M limit filled in ~1 min under portal+workers bulk POST/GET burst)
    # slipped past health-check unnoticed. Now surfaces before the OOM.
    try:
        problems.extend(await check_container_resources())
    except Exception as e:
        print(f"[health] container resources check error: {e}")

    # Broken-healthcheck / pids-usage watchdog. Added 23.07.2026 after a broken
    # healthcheck on postgrest containers spawned failed exec every ~30s for
    # 15h, leaking closed FIFOs in dockerd, exhausting FDs and hanging the box.
    # Now catches the pattern in <15 min via a single Telegram alert.
    try:
        problems.extend(await check_container_healthchecks())
    except Exception as e:
        print(f"[health] container healthcheck check error: {e}")

    if problems:
        header = f"⚠️ <b>HEALTH CHECK</b>  —  {_now_msk()}\n"
        await send_telegram(header + "\n" + "\n\n".join(problems))
        print(f"[health] ALERT sent: {len(problems)} problem(s)")
    else:
        print(f"[health] OK at {_now_msk()}")

    if recoveries:
        recovery_text = f"✅ <b>RECOVERED</b>  —  {_now_msk()}\n\n" + "\n".join(recoveries)
        await send_telegram(recovery_text)
        print(f"[health] RECOVERY sent: {len(recoveries)} item(s)")

    await _collect_metrics()


async def run_health_check():
    """Wrapper with timeout so a stuck DB connection doesn't block all future checks."""
    try:
        await asyncio.wait_for(_run_health_check_inner(), timeout=HEALTH_CHECK_TIMEOUT_SEC)
    except asyncio.TimeoutError:
        print(f"[health] WARNING: health check timed out after {HEALTH_CHECK_TIMEOUT_SEC}s")
    except Exception as exc:
        print(f"[health] ERROR in health check: {exc}")


async def _collect_metrics_for(
    db_url: str | None,
    metrics_deque: deque,
    label: str,
) -> None:
    """Record DB connection count and cumulative txn count for one database."""
    if not db_url:
        return
    try:
        conn = await asyncpg.connect(db_url, **_CONNECT_KWARGS)
        try:
            cur = await conn.fetchval(
                "SELECT count(*)::int FROM pg_stat_activity "
                "WHERE datname = current_database()"
            )
            txn = await conn.fetchval(
                "SELECT (xact_commit + xact_rollback)::bigint "
                "FROM pg_stat_database WHERE datname = current_database()"
            )
            metrics_deque.append((datetime.now(timezone.utc).timestamp(), cur or 0, txn or 0))
        finally:
            await conn.close()
    except Exception as e:
        print(f"[health] metrics collect ({label}) error: {e}")


async def _collect_metrics() -> None:
    """Record metrics for all monitored databases."""
    tasks = [_collect_metrics_for(DATABASE_URL, _METRICS, "main")]
    if INSTANTLY_DATABASE_URL:
        tasks.append(_collect_metrics_for(INSTANTLY_DATABASE_URL, _METRICS_INSTANTLY, "instantly"))
    await asyncio.gather(*tasks, return_exceptions=True)


def _extract_chart_series(
    metrics: deque,
) -> tuple[list[datetime], list[int], list[int]] | None:
    """Extract timestamps, txn rates, and connection counts from a metrics deque."""
    if len(metrics) < 3:
        return None
    pts = list(metrics)
    msk = timezone(timedelta(hours=3))
    timestamps: list[datetime] = []
    rates: list[int] = []
    conns: list[int] = []
    for i in range(1, len(pts)):
        timestamps.append(datetime.fromtimestamp(pts[i][0], tz=msk))
        rates.append(max(0, pts[i][2] - pts[i - 1][2]))
        conns.append(pts[i][1])
    if not rates:
        return None
    return timestamps, rates, conns


def _apply_xticks(ax, timestamps: list[datetime], n: int, max_ticks: int = 6) -> None:
    """Evenly spread up to max_ticks labels between the first and last point.

    Spacing the ticks by linear interpolation (instead of a fixed step plus a
    forced last tick) guarantees the final label never lands next to its
    neighbour, which used to make the two right-most times overlap.
    """
    if n <= 0:
        return
    if n == 1:
        ticks = [0]
    else:
        count = min(max_ticks, n)
        ticks = sorted({round(i * (n - 1) / (count - 1)) for i in range(count)})
    ax.set_xticks(ticks)
    ax.set_xticklabels(
        [timestamps[i].strftime("%H:%M") for i in ticks],
        color="#8E8E93",
    )


def _render_heartbeat_chart() -> bytes | None:
    """Render transactions & connections chart as PNG bytes.

    Shows a 2-column layout when Instantly DB metrics are available.
    """
    if not HAS_MATPLOTLIB:
        return None

    main_series = _extract_chart_series(_METRICS)
    inst_series = _extract_chart_series(_METRICS_INSTANTLY)

    if not main_series and not inst_series:
        return None

    BG = "#1C1C1E"
    TEXT = "#F5F5F7"
    SUBTEXT = "#8E8E93"
    GRID = "#3A3A3C"
    GREEN = "#3ECF8E"
    BLUE = "#0A84FF"
    ORANGE = "#FF9F0A"
    PURPLE = "#BF5AF2"

    ncols = 2 if (main_series and inst_series) else 1
    fig_w = 10 if ncols == 2 else 8
    fig, axes = plt.subplots(
        2, ncols, figsize=(fig_w, 4.5), facecolor=BG,
        gridspec_kw={"hspace": 0.55, "wspace": 0.3},
        squeeze=False,
    )

    for row in axes:
        for ax in row:
            ax.set_facecolor(BG)
            ax.tick_params(colors=SUBTEXT, labelsize=8)
            for spine in ax.spines.values():
                spine.set_visible(False)
            ax.yaxis.set_major_locator(MaxNLocator(integer=True, nbins=5))
            ax.grid(axis="y", color=GRID, linewidth=0.5, alpha=0.5)
            ax.set_axisbelow(True)

    col_data: list[tuple[str, list[datetime], list[int], list[int], str, str]] = []
    if main_series:
        col_data.append(("Main DB", *main_series, GREEN, BLUE))
    if inst_series:
        col_data.append(("Instantly DB", *inst_series, ORANGE, PURPLE))

    for col_idx, (db_label, timestamps, rates, conns, bar_color, line_color) in enumerate(col_data):
        ax_txn = axes[0][col_idx]
        ax_conn = axes[1][col_idx]

        total_txn = sum(rates)
        fmt_total = f"{total_txn:,}".replace(",", " ")
        ax_txn.set_title(
            f"{db_label}: Транзакции — {fmt_total}",
            color=TEXT, fontsize=11, fontweight="bold", loc="left", pad=10,
        )
        x = range(len(rates))
        ax_txn.bar(x, rates, color=bar_color, alpha=0.85, width=0.7)
        _apply_xticks(ax_txn, timestamps, len(rates))

        ax_conn.set_title(
            f"{db_label}: Подключения — {conns[-1]}",
            color=TEXT, fontsize=11, fontweight="bold", loc="left", pad=10,
        )
        x2 = range(len(conns))
        ax_conn.fill_between(x2, conns, color=line_color, alpha=0.2)
        ax_conn.plot(x2, conns, color=line_color, linewidth=1.5)
        _apply_xticks(ax_conn, timestamps, len(conns))

    # Hide unused axes when only one DB has data in a 2-col layout
    if ncols == 2 and len(col_data) < 2:
        for row in axes:
            row[1].set_visible(False)

    fig.tight_layout(pad=1.5)

    buf = io.BytesIO()
    fig.savefig(
        buf, format="png", dpi=150, bbox_inches="tight",
        facecolor=fig.get_facecolor(), edgecolor="none",
    )
    plt.close(fig)
    buf.seek(0)
    return buf.getvalue()


async def _fetch_heartbeat_db_data_generic(
    db_url: str,
    metrics_deque: deque,
    label: str = "DB",
    job_tables: list[tuple[str, str, list[str]]] | None = None,
) -> dict:
    """Collect heartbeat data from any Postgres database."""
    data: dict = {"ok": False, "error": "", "label": label}
    if not db_url:
        return data

    last_err: Exception | None = None
    for attempt in range(1, HEALTH_RETRY_ATTEMPTS + 1):
        try:
            conn = await asyncpg.connect(db_url, **_CONNECT_KWARGS)
            try:
                rows = await conn.fetch(
                    "SELECT state, count(*)::int AS n FROM pg_stat_activity "
                    "WHERE datname = current_database() GROUP BY state"
                )
                data["conn_max"] = int(await conn.fetchval("SHOW max_connections") or 0)
                data["conn_total"] = sum(r["n"] for r in rows)
                data["conn_active"] = sum(r["n"] for r in rows if r["state"] == "active")
                data["conn_idle"] = sum(r["n"] for r in rows if r["state"] == "idle")
                data["conn_idle_txn"] = sum(
                    r["n"] for r in rows
                    if r["state"] and "idle in transaction" in r["state"]
                )

                data["disk_db"] = await conn.fetchval(
                    "SELECT pg_database_size(current_database())"
                ) or 0
                try:
                    data["disk_wal"] = await conn.fetchval(
                        "SELECT coalesce(sum(size), 0)::bigint FROM pg_ls_waldir()"
                    ) or 0
                except Exception:
                    data["disk_wal"] = 0

                cur = await conn.fetchval(
                    "SELECT count(*)::int FROM pg_stat_activity "
                    "WHERE datname = current_database()"
                )
                txn = await conn.fetchval(
                    "SELECT (xact_commit + xact_rollback)::bigint "
                    "FROM pg_stat_database WHERE datname = current_database()"
                )
                metrics_deque.append((datetime.now(timezone.utc).timestamp(), cur or 0, txn or 0))

                if job_tables is not None:
                    data["active_jobs"] = await _fetch_active_jobs(conn, job_tables)

                data["ok"] = True
                return data
            finally:
                await conn.close()
        except Exception as e:
            last_err = e
            print(
                f"[health] heartbeat {label} attempt {attempt}/{HEALTH_RETRY_ATTEMPTS}: "
                f"{type(e).__name__}: {e}"
            )
            if attempt < HEALTH_RETRY_ATTEMPTS:
                await asyncio.sleep(HEALTH_RETRY_DELAY_SEC * attempt)

    data["error"] = _normalize_network_error(last_err) if last_err else "unknown"
    return data


async def _fetch_heartbeat_db_data() -> dict:
    """Collect heartbeat data from the main (Supabase) database."""
    return await _fetch_heartbeat_db_data_generic(
        DATABASE_URL, _METRICS, label="Main DB", job_tables=_JOB_TABLES,
    )


async def _fetch_heartbeat_instantly_data() -> dict:
    """Collect heartbeat data from the Instantly database."""
    return await _fetch_heartbeat_db_data_generic(
        INSTANTLY_DATABASE_URL, _METRICS_INSTANTLY, label="Instantly DB",
    )


def _format_db_section(
    data: dict,
    disk_total_gb: float,
    metrics: deque,
    label: str,
    icon: str,
    include_sparklines: bool = True,
) -> list[str]:
    """Format one DB section for the heartbeat caption."""
    parts: list[str] = [f"{icon} <b>{label}</b>"]

    if not data.get("ok"):
        err = data.get("error", "")
        if err:
            parts.append(f"  ⚠️ БД недоступна: {err}")
        return parts

    total = data["conn_total"]
    max_c = data["conn_max"]
    line = f"  🔌 Подключения: {total}"
    if max_c:
        line += f" / {max_c}"
    bits = []
    if data["conn_active"]:
        bits.append(f"active {data['conn_active']}")
    if data["conn_idle"]:
        bits.append(f"idle {data['conn_idle']}")
    if data["conn_idle_txn"]:
        bits.append(f"idle_txn {data['conn_idle_txn']}")
    if bits:
        line += f"  ({', '.join(bits)})"
    parts.append(line)

    db_bytes = data["disk_db"]
    wal_bytes = data["disk_wal"]
    total_used = db_bytes + wal_bytes

    if disk_total_gb > 0:
        disk_limit = disk_total_gb * (1024 ** 3)
        pct = total_used / disk_limit * 100 if disk_limit else 0
        filled = min(20, int(pct / 100 * 20))
        bar = "█" * filled + "░" * (20 - filled)
        parts.append(
            f"  💾 Диск: {_fmt_bytes(total_used)} / "
            f"{disk_total_gb:g} GB ({pct:.0f}%)"
        )
        parts.append(f"<code>  {bar}</code>")
    else:
        parts.append(f"  💾 Диск: {_fmt_bytes(total_used)}")

    detail = [f"БД {_fmt_bytes(db_bytes)}"]
    if wal_bytes:
        detail.append(f"WAL {_fmt_bytes(wal_bytes)}")
    parts.append("  " + " · ".join(detail))

    if include_sparklines and len(metrics) >= 2:
        pts = list(metrics)
        rates: list[int] = []
        conns: list[int] = []
        for i in range(1, len(pts)):
            delta = pts[i][2] - pts[i - 1][2]
            rates.append(max(0, delta))
            conns.append(pts[i][1])

        span_min = int((pts[-1][0] - pts[0][0]) / 60)
        total_txn = sum(rates)
        fmt_txn = f"{total_txn:,}".replace(",", " ")

        parts.append(f"  📊 Транзакции ({span_min} мин): {fmt_txn}")
        spark_r = _spark(rates)
        if spark_r:
            parts.append(f"<code>  {spark_r}</code>")

        if conns:
            mn_c, mx_c = min(conns), max(conns)
            parts.append(f"  📈 Подключения ({span_min} мин): {mn_c}–{mx_c}")
            spark_c = _spark(conns)
            if spark_c:
                parts.append(f"<code>  {spark_c}</code>")

    return parts


def _format_heartbeat_caption(
    data: dict,
    instantly_data: dict | None = None,
    include_sparklines: bool = True,
) -> str:
    """Format heartbeat caption from pre-fetched data (pure formatting, no DB)."""
    parts: list[str] = [f"<b>Отчет от {_now_msk()}</b>"]

    parts.append("")
    parts.extend(_format_db_section(
        data, DISK_TOTAL_GB, _METRICS, "Main Postgres (35434)", "🟢",
        include_sparklines=include_sparklines,
    ))

    if instantly_data and (instantly_data.get("ok") or instantly_data.get("error")):
        parts.append("")
        parts.extend(_format_db_section(
            instantly_data, 0, _METRICS_INSTANTLY,
            "Instantly Postgres (35432)", "🟠",
            include_sparklines=include_sparklines,
        ))

    return "\n".join(parts)


_JOB_TABLES: list[tuple[str, str, list[str]]] = [
    *[
        (spec.table, spec.label, list(spec.active_statuses))
        for spec in _JOB_MONITOR_SPECS
    ],
    ("ai_caller_jobs",          "AI Звонилка",       ["pending", "running"]),
    ("ai_campaigns",            "AI Кампании",       ["running"]),
    ("tg_outreach_jobs",        "TG Аутрич",         ["pending", "running"]),
    ("tg_outreach_campaigns",   "TG Кампании",       ["running"]),
    ("sales_copilot_jobs",      "Sales Copilot",     ["pending", "running"]),
]


async def _fetch_active_jobs(
    conn,
    job_tables: list[tuple[str, str, list[str]]] | None = None,
) -> list[dict]:
    """Query all job tables for active task counts (safe — skips missing tables)."""
    results: list[dict] = []
    for table, label, statuses in (job_tables or _JOB_TABLES):
        try:
            placeholders = ", ".join(f"${i+1}" for i in range(len(statuses)))
            spec = next((item for item in _JOB_MONITOR_SPECS if item.table == table), None)
            extra_filter = (
                f" AND ({spec.extra_predicate})"
                if spec and spec.extra_predicate
                else ""
            )
            rows = await conn.fetch(
                f"SELECT j.status, count(*)::int AS n "
                f"FROM public.{table} j "
                f"WHERE j.status IN ({placeholders})"
                f"{extra_filter} "
                f"GROUP BY j.status",
                *statuses,
            )
            if rows:
                total = sum(r["n"] for r in rows)
                breakdown = {r["status"]: r["n"] for r in rows}
                results.append({"label": label, "total": total, "breakdown": breakdown})
        except Exception:
            pass
    return results


def _format_active_jobs(data: dict) -> str | None:
    """Format active worker jobs from pre-fetched data."""
    jobs = data.get("active_jobs")
    if not jobs:
        return None

    active = [j for j in jobs if j["total"] > 0]
    if not active:
        return None

    total_all = sum(j["total"] for j in active)
    lines = [f"⚙️ <b>Активные задачи</b> ({total_all}):"]
    for j in sorted(active, key=lambda x: x["total"], reverse=True):
        parts = []
        for status, count in sorted(j["breakdown"].items(), key=lambda x: -x[1]):
            parts.append(f"{count} {status}")
        detail = ", ".join(parts)
        lines.append(f"  • {j['label']}: {detail}")

    return "\n".join(lines)


async def _ping_site(count: int = 5) -> str:
    """Ping the portal URL several times and return formatted latency results."""
    results: list[tuple[int, float]] = []
    try:
        async with httpx.AsyncClient(
            timeout=HTTP_TIMEOUT, follow_redirects=False,
        ) as client:
            for _ in range(count):
                try:
                    r = await client.get(PORTAL_URL)
                    ms = r.elapsed.total_seconds() * 1000
                    results.append((r.status_code, ms))
                except Exception:
                    results.append((0, 0.0))
    except Exception:
        return f"🌐 <b>Пинг сервера</b> {PORTAL_URL}: ошибка"

    ok_count = sum(1 for code, _ in results if 200 <= code < 400)
    times = [ms for _, ms in results if ms > 0]
    avg_ms = sum(times) / len(times) if times else 0

    pings = "  ".join(
        f"{code}·{ms:.0f}ms" if code else "✖"
        for code, ms in results
    )
    return (
        f"🌐 <b>Пинг сервера</b> ({ok_count}/{count}, avg {avg_ms:.0f}ms):\n"
        f"<code>  {pings}</code>"
    )


async def _ping_one_proxy(url: str, count: int) -> tuple[int, list[float]]:
    """Ping one proxy `count` times, return (ok_count, latencies_ms)."""
    ok = 0
    latencies: list[float] = []
    try:
        async with httpx.AsyncClient(proxy=url, timeout=HTTP_TIMEOUT) as client:
            for _ in range(count):
                # Same rule as check_proxy: any non-5xx, non-407 response means
                # the ping traversed the proxy. Fall back across targets so one
                # flaky target doesn't drag the success rate to 0.
                for test_url in PROXY_TEST_URLS:
                    try:
                        r = await client.get(test_url)
                        if r.status_code < 500 and r.status_code != 407:
                            ok += 1
                            latencies.append(r.elapsed.total_seconds() * 1000)
                            break
                    except Exception:
                        continue
    except Exception:
        pass
    return ok, latencies


async def _ping_proxies(count: int = 3) -> str:
    """Ping every proxy `count` times concurrently, return formatted summary."""
    if not ALL_PROXIES:
        return "🔗 <b>Прокси</b>: не настроены"

    tasks = [_ping_one_proxy(url, count) for _, url in ALL_PROXIES]
    outcomes = await asyncio.gather(*tasks, return_exceptions=True)

    rows: list[tuple[str, str, bool, int, int, float]] = []
    for (group, url), outcome in zip(ALL_PROXIES, outcomes):
        if isinstance(outcome, Exception):
            rows.append((group, _redact(url), False, 0, count, 0.0))
        else:
            ok_cnt, lats = outcome
            avg = sum(lats) / len(lats) if lats else 0.0
            rows.append((group, _redact(url), ok_cnt > 0, ok_cnt, count, avg))

    alive = sum(1 for _, _, ok, *_ in rows if ok)
    total = len(rows)

    lines = [f"🔗 <b>Прокси</b>: {alive}/{total} работают"]
    for group, addr, ok_flag, ok_cnt, cnt, avg in rows:
        icon = "✅" if ok_flag else "❌"
        if ok_flag and avg > 0:
            lines.append(f"  {icon} [{group}] {addr} — {ok_cnt}/{cnt}, avg {avg:.0f}ms")
        elif ok_flag:
            lines.append(f"  {icon} [{group}] {addr} — {ok_cnt}/{cnt}")
        else:
            lines.append(f"  {icon} [{group}] {addr} — не отвечает")

    return "\n".join(lines)



async def send_heartbeat():
    """Periodic heartbeat: chart + caption + jobs + proxies (single message)."""
    global HEARTBEAT_STARTED
    if not HEARTBEAT_STARTED:
        HEARTBEAT_STARTED = True
        await send_telegram(f"🟢 <b>HEALTH BOT ONLINE</b> — {_now_msk()}", force=True)
        return

    fetch_tasks: list = [_fetch_heartbeat_db_data(), _ping_site(), _ping_proxies()]
    if INSTANTLY_DATABASE_URL:
        fetch_tasks.append(_fetch_heartbeat_instantly_data())

    results = await asyncio.gather(*fetch_tasks, return_exceptions=True)

    db_data = results[0] if not isinstance(results[0], Exception) else {"ok": False, "error": str(results[0])}
    ping_text = results[1] if not isinstance(results[1], Exception) else "🌐 Пинг сервера: ошибка"
    proxy_text = results[2] if not isinstance(results[2], Exception) else "🔗 Прокси: ошибка"
    instantly_data: dict | None = None
    if INSTANTLY_DATABASE_URL and len(results) > 3:
        instantly_data = results[3] if not isinstance(results[3], Exception) else {"ok": False, "error": str(results[3])}

    extra_parts: list[str] = []
    jobs_text = _format_active_jobs(db_data)
    if jobs_text:
        extra_parts.append(jobs_text)

    extra_parts.append(proxy_text)
    extra_block = "\n\n".join(extra_parts)

    chart = _render_heartbeat_chart()
    if chart:
        caption = _format_heartbeat_caption(db_data, instantly_data, include_sparklines=False)
        caption += f"\n\n{ping_text}\n\n{extra_block}"
        ok = await send_telegram_photo(chart, caption=caption)
        if not ok:
            text = _format_heartbeat_caption(db_data, instantly_data, include_sparklines=True)
            text += f"\n\n{ping_text}\n\n{extra_block}"
            await send_telegram(text)
    else:
        text = _format_heartbeat_caption(db_data, instantly_data, include_sparklines=True)
        text += f"\n\n{ping_text}\n\n{extra_block}"
        await send_telegram(text)


async def run_supabase_keepalive() -> None:
    """Silently ping PostgREST to prevent the Supabase project from pausing.

    Runs every SUPABASE_KEEPALIVE_INTERVAL_SEC (default 10 min).  No alert is
    sent — keepalive failures are only logged.  The health check cycle handles
    alerting independently.
    """
    if not SUPABASE_REST_URL or not SUPABASE_KEEPALIVE_INTERVAL_SEC:
        return
    headers: dict[str, str] = {}
    if SUPABASE_REST_API_KEY:
        headers["apikey"] = SUPABASE_REST_API_KEY
        headers["Authorization"] = f"Bearer {SUPABASE_REST_API_KEY}"
    try:
        async with httpx.AsyncClient(
            timeout=HEALTH_POSTGREST_TIMEOUT_SEC, follow_redirects=False
        ) as c:
            r = await c.get(SUPABASE_REST_URL, headers=headers)
            print(f"[health] keepalive PostgREST: {r.status_code}")
    except Exception as e:
        print(f"[health] keepalive PostgREST error: {_normalize_network_error(e)}")


async def run_deadman_check():
    """Alert when health checks stop running on schedule."""
    if LAST_HEALTH_CHECK_TS <= 0:
        return
    now = asyncio.get_running_loop().time()
    lag = now - LAST_HEALTH_CHECK_TS
    if lag > DEADMAN_GRACE_SEC:
        await send_telegram(
            f"🚨 <b>DEADMAN</b>: health-check не запускался {int(lag)}с (grace={DEADMAN_GRACE_SEC}с)",
            force=True,
        )
        print(f"[health] DEADMAN alert sent: lag={int(lag)}s")


# ── Main ────────────────────────────────────────────────────────────────────

async def run_li_outreach_report() -> None:
    """Ежедневный дайджест здоровья LinkedIn-аутрича → health-бот (19:00 МСК).

    Зеркалит app/scripts/li-outreach-healthcheck.sql. Каждый инвариант должен
    быть 0; пункты GPT и «ошибки» — информационный контекст, не фейл.
    """
    try:
        conn = await asyncpg.connect(
            DATABASE_URL, **_connect_kwargs(LI_REPORT_COMMAND_TIMEOUT_SEC)
        )
    except Exception as e:
        await send_telegram(
            f"🔗 <b>LinkedIn outreach</b>\nНе смог подключиться к БД для отчёта: "
            f"{_normalize_network_error(e)}",
            force=True,
        )
        return
    try:
        # Плейсхолдеры и дубли считаются одним проходом.
        #
        # Раньше это были два отдельных запроса, и каждый разворачивал всю
        # переписку всех лидов: `jsonb_array_elements` по li_leads — это полный
        # проход с распаковкой TOAST, самое дорогое, что есть в отчёте. Первый
        # из них 08.08.2026 не уложился в потолок и уронил весь отчёт.
        #
        # Группировка по (лид, текст) делается один раз, а обе цифры снимаются
        # с неё: raw_ph — сумма повторов у текстов с плейсхолдером (это ровно то
        # же число сообщений, что считал COUNT(*) раньше), dups — сколько групп
        # встретилось больше одного раза. Регулярка теперь проверяет уникальные
        # тексты, а не каждое сообщение.
        #
        # Замер на 240 тыс. сообщений: 3,7 с двумя запросами против 0,21 с одним.
        # Дубли считаются в окне DUP_WINDOW_DAYS, плейсхолдеры — за всё время.
        #
        # Разница намеренная. Сырой {{...}} в отправленном — вечный факт: он
        # либо есть в базе, либо нет, и «состарить» его нечем. А дубль — это
        # событие: четыре дубля 15-17.08.2026 остались бы в счётчике навсегда,
        # отчёт горел бы красным и после фикса, и первый же настоящий рецидив
        # утонул бы в этом фоне. Чистить conversation_history ради зелёного
        # отчёта нельзя — это реальная история отправок.
        counts = await conn.fetchrow(rf"""
            WITH per_message AS (
              SELECT l.id AS lead_id, m->>'content' AS content,
                     CASE WHEN m->>'ts' ~ '^\d{{4}}-\d{{2}}-\d{{2}}T'
                          THEN (m->>'ts')::timestamptz END AS ts
              FROM li_leads l
              CROSS JOIN LATERAL jsonb_array_elements(COALESCE(l.conversation_history,'[]'::jsonb)) m
              WHERE m->>'role'='assistant'
            ),
            grouped AS (
              SELECT lead_id, content, COUNT(*) AS n, MAX(ts) AS last_ts
              FROM per_message GROUP BY lead_id, content
            )
            SELECT
              COALESCE(SUM(n) FILTER (WHERE content ~ '\{{\{{.*\}}\}}'), 0) AS raw_ph,
              -- Заглушки вида [Ваше имя] — след того, что модель сочинила письмо
              -- вместо реплики и не смогла заполнить подпись. 19.08.2026 такое
              -- ушло человеку из Oracle, а мониторинг молчал: инвариант выше
              -- ищет фигурные скобки, а тут квадратные.
              -- Окно то же, что у дублей, и по той же причине: исторический хвост
              -- (16 сообщений с мая на момент добавления) держал бы отчёт красным
              -- вечно и топил бы в себе новый случай.
              COALESCE(SUM(n) FILTER (
                WHERE content ~ '\[[^\]]{{2,60}}\]'
                  AND last_ts > NOW() - INTERVAL '{LI_DUP_WINDOW_DAYS} days'
              ), 0) AS bracket_ph,
              COUNT(*) FILTER (
                WHERE n > 1 AND length(content) > 20
                  AND last_ts > NOW() - INTERVAL '{LI_DUP_WINDOW_DAYS} days'
              ) AS dups
            FROM grouped
        """)
        raw_ph = (counts["raw_ph"] or 0) if counts else 0
        bracket_ph = (counts["bracket_ph"] or 0) if counts else 0
        dups = (counts["dups"] or 0) if counts else 0
        replied_not_stopped = await conn.fetchval("""
            SELECT COUNT(*) FROM li_campaign_leads cl
            JOIN li_campaigns c ON c.id=cl.campaign_id
            WHERE cl.user_replied=true AND c.stop_on_reply=true
              AND cl.status NOT IN ('completed','error','skipped')
        """) or 0
        # Причина дублей, а не их след. Один лид, живущий сразу в двух running
        # кампаниях, получит каждый шаг дважды: гард от повтора есть только на
        # инвайте (processInviteStep смотрит на lead.status), у message-шага
        # его нет. 17.08.2026 два запуска на одном lead_list (163 из 163
        # общих лидов) успели отправить четыре двойных сообщения, прежде чем
        # это заметили — а вот такой счётчик показал бы 163 в первый же день.
        leads_multi_campaign = await conn.fetchval("""
            SELECT COUNT(*) FROM (
              SELECT cl.lead_id FROM li_campaign_leads cl
              JOIN li_campaigns c ON c.id = cl.campaign_id
              WHERE c.status = 'running'
                AND cl.status NOT IN ('completed','error','skipped')
              GROUP BY cl.lead_id
              HAVING COUNT(DISTINCT cl.campaign_id) > 1
            ) x
        """) or 0
        conn_no_welcome = await conn.fetchval("""
            SELECT COUNT(*) FROM li_campaign_leads cl
            JOIN li_campaigns c ON c.id=cl.campaign_id
            JOIN li_leads l ON l.id=cl.lead_id
            WHERE cl.invite_accepted=true AND c.status='running'
              AND c.welcome_message IS NOT NULL AND c.welcome_message<>''
              AND cl.welcome_sent_at IS NULL AND l.status='connected'
        """) or 0
        gpt = await conn.fetchrow("""
            SELECT
              COUNT(*) FILTER (WHERE message ILIKE '%GPT персонализировал%') AS ok,
              COUNT(*) FILTER (WHERE message ILIKE '%вернул шаблон без изменений%') AS noop,
              COUNT(*) FILTER (WHERE message ILIKE '%Ошибка GPT%') AS err,
              -- Сколько раз проверка не пустила ответ модели в отправку.
              -- Единственный способ увидеть это на пути ИНВАЙТА: его текст
              -- в conversation_history не попадает, поэтому инвариант по
              -- квадратным скобкам туда не дотягивается.
              COUNT(*) FILTER (WHERE message ILIKE '%GPT вернул не сообщение%'
                                  OR message ILIKE '%GPT вернул не инвайт%') AS guard_blocked
            FROM li_campaign_logs WHERE created_at > NOW() - INTERVAL '24 hours'
        """)
        # Only li_campaigns.ai_model is on the live GPT path. li_settings.openai_model
        # is a dead BYOK-era column no code reads (see BYOK removal 2026-05), so a bare
        # value there can't break Requesty — don't flag it (was a false 🔴 on 2026-07-08).
        bare = await conn.fetchrow("""
            SELECT
              (SELECT COUNT(*) FROM li_campaigns WHERE ai_model IS NOT NULL AND ai_model<>'' AND ai_model NOT LIKE '%/%') AS camp
        """)
        byok = await conn.fetchval("""
            SELECT COUNT(*) FROM li_settings WHERE openai_api_key IS NOT NULL AND openai_api_key<>''
        """) or 0
        errs_24h = await conn.fetchval("""
            SELECT COUNT(*) FROM li_campaign_logs
            WHERE created_at > NOW() - INTERVAL '24 hours'
              AND level IN ('warning','error') AND message NOT ILIKE '%Дневной лимит%'
        """) or 0
        invites_today = await conn.fetchval("""
            SELECT COUNT(*) FROM li_campaign_logs
            WHERE created_at >= CURRENT_DATE AND message ILIKE '%Инвайт отправлен%'
        """) or 0
    except Exception as e:
        # У asyncpg таймаут команды приходит пустым TimeoutError, и в телеграм
        # уезжало бесполезное «TimeoutError: no details». Говорим, что именно
        # случилось и во что не уложились.
        detail = (
            f"запрос не уложился в {LI_REPORT_COMMAND_TIMEOUT_SEC} с"
            if isinstance(e, asyncio.TimeoutError)
            else _format_exception_message(e)
        )
        await send_telegram(
            f"🔗 <b>LinkedIn outreach</b>\nОшибка при сборе отчёта: {detail}",
            force=True,
        )
        return
    finally:
        await conn.close()

    gpt_ok, gpt_noop, gpt_err = (gpt["ok"] or 0), (gpt["noop"] or 0), (gpt["err"] or 0)
    guard_blocked = (gpt["guard_blocked"] or 0) if gpt else 0
    bare_total = bare["camp"] or 0

    def mark(v: int) -> str:
        return "✅" if v == 0 else "⚠️"

    hard_fail = any(v > 0 for v in (
        raw_ph, bracket_ph, dups, leads_multi_campaign, replied_not_stopped,
        conn_no_welcome, bare_total, byok, gpt_err,
    ))
    header = (
        "🔴 LinkedIn outreach — есть отклонения"
        if hard_fail else
        "🟢 LinkedIn outreach — всё чисто"
    )

    lines = [
        f"<b>{header}</b>",
        f"<i>{_now_msk()}</i>",
        "",
        f"{mark(raw_ph)} Сырые плейсхолдеры в отправленных: {raw_ph}",
        f"{mark(bracket_ph)} Заглушки [в скобках] от GPT (за {LI_DUP_WINDOW_DAYS} дн.): {bracket_ph}",
        f"{mark(dups)} Дубли сообщений лиду (за {LI_DUP_WINDOW_DAYS} дн.): {dups}",
        f"{mark(leads_multi_campaign)} Лиды сразу в двух running-кампаниях: {leads_multi_campaign}",
        f"{mark(replied_not_stopped)} Ответили, но не остановлены: {replied_not_stopped}",
        f"{mark(conn_no_welcome)} Connected без welcome (running): {conn_no_welcome}",
        f"{mark(bare_total)} Bare-модели без provider/: {bare_total}",
        f"{mark(byok)} Остаточные BYOK-ключи: {byok}",
        f"{mark(gpt_err)} GPT за 24ч: ok {gpt_ok} / шаблон {gpt_noop} / ошибок {gpt_err}",
        f"{mark(guard_blocked)} GPT сочинил письмо, отбито проверкой: {guard_blocked}",
        "",
        f"ℹ️ Инвайтов сегодня: {invites_today} · прочих ошибок за 24ч: {errs_24h} "
        f"(обычно битые профили из импорта)",
    ]
    await send_telegram("\n".join(lines), force=True)


async def main():
    _require("DATABASE_URL or SUPABASE_DB_URL", DATABASE_URL)
    _require("TELEGRAM_HEALTH_CHAT_ID", TELEGRAM_CHAT_ID)
    _require("TELEGRAM_HEALTH_BOT_TOKEN or TELEGRAM_BOT_TOKEN", TELEGRAM_BOT_TOKEN)

    await _ensure_settings_table()

    scheduler = AsyncIOScheduler()

    # Health check every 5 min
    # misfire_grace_time + max_instances ensure a stuck check doesn't block all future runs
    scheduler.add_job(
        run_health_check, "interval",
        seconds=HEALTH_INTERVAL_SEC,
        id="health",
        max_instances=2,
        misfire_grace_time=HEALTH_INTERVAL_SEC,
    )
    scheduler.add_job(
        run_deadman_check, "interval",
        seconds=max(60, HEALTH_INTERVAL_SEC),
        id="deadman",
        max_instances=2,
        misfire_grace_time=HEALTH_INTERVAL_SEC,
    )
    scheduler.add_job(
        run_job_monitor, "interval",
        seconds=JOB_MONITOR_INTERVAL_SEC,
        id="job_monitor",
        max_instances=1,
        misfire_grace_time=JOB_MONITOR_INTERVAL_SEC,
    )
    scheduler.add_job(
        send_heartbeat, "interval",
        seconds=HEARTBEAT_INTERVAL_SEC,
        id="heartbeat",
        max_instances=2,
        misfire_grace_time=HEARTBEAT_INTERVAL_SEC,
    )
    if SUPABASE_KEEPALIVE_INTERVAL_SEC > 0 and SUPABASE_REST_URL:
        scheduler.add_job(
            run_supabase_keepalive, "interval",
            seconds=SUPABASE_KEEPALIVE_INTERVAL_SEC,
            id="supabase_keepalive",
            max_instances=2,
            misfire_grace_time=SUPABASE_KEEPALIVE_INTERVAL_SEC,
        )

    # Daily LinkedIn-outreach health digest at 19:00 MSK == 16:00 UTC.
    # MSK is a fixed UTC+3 (no DST since 2014), so a UTC cron hour is stable.
    # misfire_grace_time=1h: if the container was down at 16:00, still fire on
    # the next start within the hour rather than silently skipping the day.
    scheduler.add_job(
        run_li_outreach_report, "cron",
        hour=16, minute=0, timezone="UTC",
        id="li_outreach_report",
        max_instances=1,
        misfire_grace_time=3600,
    )

    # Run first health check now
    await run_health_check()
    await run_job_monitor()
    await send_heartbeat()

    scheduler.start()

    # Poll Telegram for /mute, /вкл, /alerts in the health chat
    poll_task = asyncio.create_task(poll_telegram_commands())

    proxy_count = len(ALL_PROXIES)
    keepalive_info = (
        f"keepalive every {SUPABASE_KEEPALIVE_INTERVAL_SEC}s"
        if SUPABASE_KEEPALIVE_INTERVAL_SEC > 0 and SUPABASE_REST_URL
        else "keepalive disabled"
    )
    instantly_info = (
        "instantly_db=configured"
        if INSTANTLY_DATABASE_URL
        else "instantly_db=not set"
    )
    print(
        f"[health] Started: site={PORTAL_URL}, server={SERVER_IP}, "
        f"proxies={proxy_count}, {instantly_info}, health every {HEALTH_INTERVAL_SEC}s, "
        f"job monitor every {JOB_MONITOR_INTERVAL_SEC}s "
        f"(stuck after {JOB_STUCK_MINUTES} min), "
        f"heartbeat every {HEARTBEAT_INTERVAL_SEC}s, {keepalive_info}. "
        "Commands in chat: /mute /вкл /alerts"
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

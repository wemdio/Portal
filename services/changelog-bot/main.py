"""
Changelog-bot: ежедневный дайджест обновлений портала в Telegram.

Расписание:
  - Будни (Пн–Пт) в 8:30 МСК (05:30 UTC).
  - Понедельник → окно с Пт 8:30 МСК до Пн 8:30 МСК.
  - Вт–Пт → окно за последние 24 ч (со вчера 8:30 до сегодня 8:30 МСК).
  - Выходные — бот молчит.
  - Если коммитов за период не было — бот ничего не пишет.

Переменные окружения:
  CHANGELOG_BOT_TOKEN      — токен Telegram-бота
  CHANGELOG_CHAT_ID        — ID чата/группы куда постить
  GITHUB_TOKEN             — Personal Access Token (для приватного репо)
  GITHUB_REPO              — owner/repo  (default: wemdio/Portal)
  REQUESTY_CHANGELOG_API_KEY   — ключ Requesty для AI-саммари
  CHANGELOG_OPENROUTER_MODEL  — модель (default: google/gemini-2.5-flash, 1M токенов контекста)
  CHANGELOG_THREAD_ID      — ID топика в супергруппе (опционально, для отправки в тред)
  CHANGELOG_RUN_NOW        — если "1", запустить дайджест сразу при старте (для теста)
  DATABASE_URL             — Postgres URL (опционально, для хранения истории саммари)
  CHANGELOG_WEBHOOK_PORT   — порт health-check HTTP сервера (default: 8095)
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone
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
from aiohttp import web
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

# ── Env config ───────────────────────────────────────────────────────────────

TELEGRAM_BOT_TOKEN = os.environ.get("CHANGELOG_BOT_TOKEN", "")
CHAT_ID = os.environ.get("CHANGELOG_CHAT_ID", "")
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
GITHUB_REPO = os.environ.get("GITHUB_REPO", "wemdio/Portal")
OPENROUTER_API_KEY = os.environ.get("REQUESTY_CHANGELOG_API_KEY", "")
AI_MODEL = os.environ.get("CHANGELOG_OPENROUTER_MODEL", "google/gemini-2.5-flash")
THREAD_ID = os.environ.get("CHANGELOG_THREAD_ID", "")
RUN_NOW = os.environ.get("CHANGELOG_RUN_NOW", "") == "1"
DATABASE_URL = os.environ.get("DATABASE_URL") or os.environ.get("SUPABASE_DB_URL", "")
WEBHOOK_PORT = int(os.environ.get("CHANGELOG_WEBHOOK_PORT", "8095"))

MSK = timezone(timedelta(hours=3))


def _require(name: str, val: str) -> str:
    if not val:
        print(f"[changelog] FATAL: {name} is not set", flush=True)
        sys.exit(1)
    return val


# ── DB pool ───────────────────────────────────────────────────────────────────

_pool: asyncpg.Pool | None = None


async def get_pool() -> asyncpg.Pool | None:
    global _pool
    if not DATABASE_URL:
        return None
    if _pool is None:
        _pool = await asyncpg.create_pool(
            DATABASE_URL, min_size=1, max_size=3, statement_cache_size=0
        )
    return _pool


async def ensure_table() -> None:
    pool = await get_pool()
    if not pool:
        return
    await pool.execute("""
        CREATE TABLE IF NOT EXISTS changelog_digests (
            id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            window_from timestamptz NOT NULL,
            window_to   timestamptz NOT NULL,
            summary     text NOT NULL DEFAULT '',
            sent_at     timestamptz NOT NULL DEFAULT now()
        )
    """)
    print("[changelog] DB table ready", flush=True)


async def already_sent(since: datetime, until: datetime) -> bool:
    pool = await get_pool()
    if not pool:
        return False
    row = await pool.fetchrow(
        "SELECT id FROM changelog_digests WHERE window_from = $1 AND window_to = $2",
        since, until,
    )
    return row is not None


async def save_digest(since: datetime, until: datetime, summary: str) -> None:
    pool = await get_pool()
    if not pool:
        return
    await pool.execute(
        "INSERT INTO changelog_digests (window_from, window_to, summary) VALUES ($1, $2, $3)",
        since, until, summary,
    )
    print("[changelog] Digest saved to DB", flush=True)


# ── Time window helpers ───────────────────────────────────────────────────────

def _compute_window(now_msk: datetime) -> tuple[datetime, datetime]:
    """Return (since, until) in UTC for the reporting window."""
    boundary = now_msk.replace(hour=9, minute=0, second=0, microsecond=0)
    weekday = now_msk.weekday()  # 0=Mon … 6=Sun

    if weekday == 0:  # Monday → since Friday 08:30 MSK
        since_msk = boundary - timedelta(days=3)
    else:
        since_msk = boundary - timedelta(days=1)

    return since_msk.astimezone(timezone.utc), boundary.astimezone(timezone.utc)


# ── GitHub API ────────────────────────────────────────────────────────────────

async def fetch_commits(since: datetime, until: datetime) -> list[dict[str, Any]]:
    headers: dict[str, str] = {"Accept": "application/vnd.github+json"}
    if GITHUB_TOKEN:
        headers["Authorization"] = f"Bearer {GITHUB_TOKEN}"

    params = {
        "sha": "main",
        "since": since.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "until": until.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "per_page": "100",
    }

    url = f"https://api.github.com/repos/{GITHUB_REPO}/commits"
    commits: list[dict[str, Any]] = []

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            while url:
                r = await client.get(url, headers=headers, params=params if commits == [] else {})
                if r.status_code == 200:
                    page = r.json()
                    commits.extend(page)
                    link = r.headers.get("Link", "")
                    next_url = _parse_next_link(link)
                    url = next_url or ""
                else:
                    print(f"[changelog] GitHub API error {r.status_code}: {r.text[:200]}", flush=True)
                    break
    except Exception as e:
        print(f"[changelog] GitHub fetch error: {e}", flush=True)

    return commits


def _parse_next_link(link_header: str) -> str | None:
    for part in link_header.split(","):
        part = part.strip()
        if 'rel="next"' in part:
            url_part = part.split(";")[0].strip()
            return url_part.strip("<>")
    return None


def _extract_commit_info(commits: list[dict[str, Any]]) -> list[str]:
    messages = []
    for c in commits:
        msg: str = c.get("commit", {}).get("message", "").strip()
        if not msg:
            continue
        first_line = msg.splitlines()[0].strip()
        if first_line:
            messages.append(first_line)
    return messages


# ── AI summary ────────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """\
Ты — технический редактор продуктовой команды. По списку коммит-сообщений из git напиши дайджест обновлений портала.

## Структура ответа

Ответ должен состоять из трёх блоков. Каждый блок начинается с заголовка, за которым идут пункты списка.
Если в каком-то блоке нечего написать — блок полностью пропускай (не пиши пустой заголовок).

Блок 1 — заголовок: «Обновления основного функционала портала {period}:»
Сюда идут изменения, затрагивающие интерфейс СПЕЦИАЛИСТОВ (наш внутренний портал).

Блок 2 — заголовок: «Обновления функционала клиентского доступа на портале {period}:»
Сюда идут изменения, затрагивающие КЛИЕНТСКИЙ портал.

Блок 3 — заголовок: «Прочие технические обновления:»
Сюда идут: инфраструктурные, косметические и прочие технические изменения без пользовательского эффекта.

## Как разложить коммит по блокам

Многие инструменты (парсеры, цепочки писем, кампании, конструктор баз, поиск компаний, брифы, ответы, лиды и т.п.) существуют И в клиентском портале, И в спец-портале. Один и тот же инструмент может быть упомянут в обоих блоках, если изменения затронули обе стороны.

Признаки КЛИЕНТСКОГО изменения (→ Блок 2):
- Префикс коммита начинается с `client-` или содержит слово `client` (например: client-tools, client-onboarding, client-replies, client-leads, client-portal, client-ui).
- В теле упоминаются «клиент», «клиентский», «клиентском».
- Пути в коммите ведут в `app/src/app/client/…`.
- Инструменты, живущие только в клиенте: тариф (tariff), поддержка клиентов, бриф клиента, ответы клиентов, лиды клиента, дашборд клиента, онбординг.

Признаки СПЕЦ-изменения (→ Блок 1):
- Всё остальное, что не подпадает под клиентские признаки.
- Инструменты, живущие только в спец-портале (не имеют клиентского аналога): AI Звонилка, TG Outreach, TG-парсер, TG-транскрибации, LinkedIn Outreach, CIS Lead Finder, Habr Career, Sales Copilot, Reputation Finder, Atmos-аналитика, RDP, Автоотчёты, аудио-расшифровка, Наш аутрич / Бугор аутрич, ОКВЭД справочник, база знаний, Hypothesis Engine (projects), Instantly (админ-панель), 2ГИС-парсер (админ), ЯКарты-парсер.

Признаки ПРОЧЕГО (→ Блок 3):
- Инфраструктура (docker, compose, миграции, лимиты памяти/CPU, healthcheck).
- Изменения в скриптах, CI, воркерах, бэкапах, БД-индексах.
- Косметика без видимого эффекта для пользователя.

## Правило группировки (КРИТИЧНО)

ВСЕ коммиты про один инструмент собирай в ОДИН пункт (или в подряд идущий блок пунктов), НЕ РАЗБРАСЫВАЙ по документу.

Плохо (было):
- Добавлен отдельный инструмент парсера 2ГИС.
- ... (15 других пунктов) ...
- Ограничен экспорт CSV из парсера 2ГИС до 500 тысяч строк.
- Улучшены фильтры парсера 2ГИС.

Хорошо (должно быть):
- Парсер 2ГИС: выделен в отдельный инструмент, добавлены иерархические фильтры по рубрикам, улучшены фильтры источников, ограничен экспорт CSV до 500 тыс. строк.

Приёмы группировки:
- Один пункт-«шапка» на инструмент, внутри перечисление через запятую или точку с запятой.
- Если пунктов про инструмент много (>3-4) — можно оставить главный пункт и подпункты через двоеточие + перечисление.
- Порядок внутри пункта: сначала новое, потом улучшения, потом исправления.

Порядок пунктов внутри блока:
1. Крупные новые инструменты и фичи в существующих.
2. Улучшения UI/UX и работы существующих инструментов.
3. Исправления багов.

## Правила форматирования

- Пиши на русском языке.
- Каждый пункт начинается с «- » (тире и пробел). Без эмодзи.
- Используй глагол действия: «добавлен», «обновлён», «исправлен», «улучшен».
- Между блоками — одна пустая строка.
- НИКОГДА не используй markdown: никаких бэктиков (`), звёздочек (*), подчёркиваний (_), решёток (#).
- Пиши простым языком без технических терминов («идемпотентность», «upsert», «миграция», «рефакторинг» и т.п.).
- Не включай: SHA, имена файлов, названия веток, номера PR.
- Игнорируй коммиты: Merge branch, Merge pull request, а также любые упоминания об удалении файлов, скриптов, секретов, ключей.
- Если все коммиты служебные и нечего показать — ответь пустой строкой.
- Не добавляй никаких пояснений — только блоки с пунктами.
"""


MAX_MESSAGES = 400
MAX_USER_CONTENT_CHARS = 400_000


async def summarize_with_ai(
    messages: list[str],
    period: str = "за прошедшие сутки",
    model_override: str | None = None,
) -> str:
    if not messages:
        return ""

    original_count = len(messages)
    truncated_count = 0
    if original_count > MAX_MESSAGES:
        messages = messages[:MAX_MESSAGES]
        truncated_count = original_count - MAX_MESSAGES
        print(
            f"[changelog] Too many messages ({original_count}) — capped at {MAX_MESSAGES}, dropped {truncated_count}",
            flush=True,
        )

    tail = f"\n- …и ещё {truncated_count} коммитов не показаны" if truncated_count else ""
    user_content = (
        f"Период: {period}\n\nСписок коммит-сообщений:\n"
        + "\n".join(f"- {m}" for m in messages)
        + tail
    )

    if len(user_content) > MAX_USER_CONTENT_CHARS:
        cut = MAX_USER_CONTENT_CHARS
        newline = user_content.rfind("\n", 0, cut)
        if newline > 0:
            cut = newline
        print(
            f"[changelog] user_content too long ({len(user_content)} chars) — truncating to {cut}",
            flush=True,
        )
        user_content = user_content[:cut] + "\n- …остальные коммиты обрезаны (слишком много)"

    model = model_override or AI_MODEL
    print(f"[changelog] AI model: {model}, input chars: {len(user_content)}", flush=True)
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ],
        "temperature": 0.3,
    }

    try:
        async with httpx.AsyncClient(timeout=180) as client:
            r = await client.post(
                "https://router.requesty.ai/v1/chat/completions",
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                    "HTTP-Referer": "https://portal.app",
                    "X-Title": "Portal - Changelog Bot",
                },
                json=payload,
            )
            if not r.is_success:
                print(f"[changelog] AI error {r.status_code}: {r.text[:200]}", flush=True)
                return ""
            data = r.json()
            return data.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
    except Exception as e:
        print(f"[changelog] AI call error: {e}", flush=True)
        return ""


# ── Telegram ──────────────────────────────────────────────────────────────────

async def _send_single(text: str) -> bool:
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload: dict[str, Any] = {
        "chat_id": CHAT_ID,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    if THREAD_ID and int(THREAD_ID) != 1:
        payload["message_thread_id"] = int(THREAD_ID)
    print(f"[changelog] TG payload: chat_id={CHAT_ID} thread_id={THREAD_ID or 'none'} text_len={len(text)}", flush=True)
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(connect=10, read=60, write=10, pool=10)) as client:
            r = await client.post(url, json=payload)
            print(f"[changelog] TG response status: {r.status_code}", flush=True)
            data = r.json()
            if not data.get("ok"):
                print(f"[changelog] TG sendMessage error: {data.get('description', r.text[:300])}", flush=True)
                return False
            return True
    except Exception as e:
        print(f"[changelog] TG sendMessage exception ({type(e).__name__}): {e}", flush=True)
        return False


async def send_message(text: str) -> bool:
    max_len = 4000
    if len(text) <= max_len:
        return await _send_single(text)

    # Split on newlines keeping parts under the limit
    parts: list[str] = []
    current = ""
    for line in text.splitlines(keepends=True):
        if len(current) + len(line) > max_len:
            if current:
                parts.append(current.rstrip())
            current = line
        else:
            current += line
    if current.strip():
        parts.append(current.rstrip())

    print(f"[changelog] Message too long ({len(text)} chars), splitting into {len(parts)} parts", flush=True)
    ok = True
    for part in parts:
        ok = await _send_single(part) and ok
    return ok


# ── Core job ──────────────────────────────────────────────────────────────────

async def run_digest(
    *,
    force: bool = False,
    days_override: int | None = None,
    model_override: str | None = None,
    skip_already_sent_check: bool = False,
) -> None:
    now_msk = datetime.now(MSK)
    weekday = now_msk.weekday()
    print(f"[changelog] run_digest triggered: {now_msk.strftime('%d.%m.%Y %H:%M MSK')} weekday={weekday}", flush=True)

    if weekday >= 5 and not force:
        print("[changelog] Weekend — skip.", flush=True)
        return

    if days_override is not None:
        until_utc = datetime.now(timezone.utc)
        since_utc = until_utc - timedelta(days=days_override)
        period_label = f"за последние {days_override} дн."
    else:
        since_utc, until_utc = _compute_window(now_msk)
        period_label = "за прошедшие выходные и пятницу" if weekday == 0 else "за прошедшие сутки"

    print(f"[changelog] Window: {since_utc.strftime('%Y-%m-%dT%H:%M:%SZ')} → {until_utc.strftime('%Y-%m-%dT%H:%M:%SZ')}", flush=True)

    if not RUN_NOW and not skip_already_sent_check and await already_sent(since_utc, until_utc):
        print("[changelog] Digest for this window already sent — skipping.", flush=True)
        return

    commits = await fetch_commits(since_utc, until_utc)
    print(f"[changelog] Fetched {len(commits)} commits from GitHub", flush=True)

    if not commits:
        print("[changelog] No commits in window — nothing to send.", flush=True)
        return

    messages = _extract_commit_info(commits)
    print(f"[changelog] Unique messages: {len(messages)}", flush=True)
    for m in messages:
        print(f"  • {m}", flush=True)

    if not messages:
        print("[changelog] No meaningful commit messages — skip.", flush=True)
        return

    summary = await summarize_with_ai(messages, period=period_label, model_override=model_override)

    if not summary or not summary.strip():
        print("[changelog] AI returned empty summary — nothing to send.", flush=True)
        return

    escaped = summary.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    raw_lines = escaped.splitlines()
    lines = []
    prev_is_header = False
    for line in raw_lines:
        stripped = line.strip()
        is_header = stripped.endswith(":") and not stripped.startswith("-")
        is_empty = stripped == ""

        if is_empty and prev_is_header:
            prev_is_header = False
            continue

        if is_header:
            lines.append(f"<b>{stripped}</b>")
            prev_is_header = True
        else:
            lines.append(line)
            prev_is_header = False

    text = "\n".join(lines)
    print(f"[changelog] Sending message ({len(text)} chars)...", flush=True)
    ok = await send_message(text)
    print(f"[changelog] Message sent: {ok}", flush=True)
    if ok:
        await save_digest(since_utc, until_utc, summary)


# ── Health check server ───────────────────────────────────────────────────────

async def handle_health(_request: web.Request) -> web.Response:
    return web.json_response({"status": "ok", "service": "changelog-bot"})


# ── Catchup on startup ────────────────────────────────────────────────────────

async def _run_catchup() -> None:
    """При старте проверяем: если сегодня будний день, уже после 9:00 МСК
    и саммари за текущее окно ещё не отправлялось — запускаем дайджест."""
    now_msk = datetime.now(MSK)
    weekday = now_msk.weekday()
    if weekday >= 5:
        return

    nine_am = now_msk.replace(hour=9, minute=0, second=0, microsecond=0)
    if now_msk < nine_am:
        return

    since_utc, until_utc = _compute_window(now_msk)
    if await already_sent(since_utc, until_utc):
        print("[changelog] Catchup: digest already sent for this window — skipping.", flush=True)
        return

    print("[changelog] Catchup: missed digest detected — running now.", flush=True)
    await run_digest()


# ── Main ──────────────────────────────────────────────────────────────────────

def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Portal changelog bot")
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run digest immediately and exit (no scheduler, no health server, bypasses weekend check).",
    )
    parser.add_argument(
        "--days",
        type=int,
        default=None,
        help="Override window: last N days back from now (only with --once).",
    )
    parser.add_argument(
        "--model",
        type=str,
        default=None,
        help="Override AI model id (e.g. google/gemini-2.0-flash-001 for 1M-token context).",
    )
    return parser.parse_args()


async def run_once(days: int | None, model: str | None) -> None:
    _require("CHANGELOG_BOT_TOKEN", TELEGRAM_BOT_TOKEN)
    _require("CHANGELOG_CHAT_ID", CHAT_ID)
    _require("REQUESTY_CHANGELOG_API_KEY", OPENROUTER_API_KEY)
    await ensure_table()
    await run_digest(
        force=True,
        days_override=days,
        model_override=model,
        skip_already_sent_check=True,
    )


async def main() -> None:
    _require("CHANGELOG_BOT_TOKEN", TELEGRAM_BOT_TOKEN)
    _require("CHANGELOG_CHAT_ID", CHAT_ID)
    _require("REQUESTY_CHANGELOG_API_KEY", OPENROUTER_API_KEY)

    await ensure_table()

    app = web.Application()
    app.router.add_get("/health", handle_health)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", WEBHOOK_PORT)
    await site.start()
    print(f"[changelog] Health server on 0.0.0.0:{WEBHOOK_PORT}/health", flush=True)

    if RUN_NOW:
        print("[changelog] CHANGELOG_RUN_NOW=1 — running digest immediately", flush=True)
        await run_digest()
    else:
        await _run_catchup()

    scheduler = AsyncIOScheduler()
    scheduler.add_job(
        run_digest,
        CronTrigger(day_of_week="mon-fri", hour=6, minute=0, timezone="UTC"),
        id="daily_digest",
        max_instances=1,
    )
    scheduler.start()
    print(f"[changelog] Scheduled: Mon–Fri at 09:00 MSK (06:00 UTC). Repo: {GITHUB_REPO}, model: {AI_MODEL}", flush=True)

    while True:
        await asyncio.sleep(3600)


if __name__ == "__main__":
    args = _parse_args()
    if args.once:
        asyncio.run(run_once(days=args.days, model=args.model))
    else:
        asyncio.run(main())

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
  CHANGELOG_OPENROUTER_MODEL  — модель (default: google/gemini-2.0-flash-001)
  CHANGELOG_THREAD_ID      — ID топика в супергруппе (опционально, для отправки в тред)
  CHANGELOG_RUN_NOW        — если "1", запустить дайджест сразу при старте (для теста)
  DATABASE_URL             — Postgres URL (опционально, для хранения истории саммари)
  CHANGELOG_WEBHOOK_PORT   — порт health-check HTTP сервера (default: 8095)
"""
from __future__ import annotations

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
AI_MODEL = os.environ.get("CHANGELOG_OPENROUTER_MODEL", "anthropic/claude-sonnet-4-5")
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
Ты — технический редактор продуктовой команды. Твоя задача — по списку коммит-сообщений из git \
написать краткий человекочитаемый дайджест обновлений для команды и клиентов.

## Приоритетность и порядок пунктов (сверху вниз)

Сортируй итоговые пункты строго в следующем порядке приоритетов:

1. 🆕 Новый функционал для специалистов — инструменты и разделы с меткой [спец] в справочнике.
   Обязательно укажи: что это, где находится (раздел → подраздел), что делает.
2. 👤 Новый функционал для клиентского доступа — изменения в разделах с меткой [клиент] или [спец+клиент].
   Также укажи расположение и назначение.
3. 🔧 Исправление критических багов в функционале для специалистов (метка [спец]).
4. 🐛 Исправление критических багов в функционале для клиентов (метка [клиент] или [спец+клиент]).
   Если в коммите непонятно к чему относится исправление — используй метку из справочника инструментов выше.
5. После всех пунктов выше — добавь отдельный маленький блок с заголовком «Технические обновления:»,
   в котором перечисли остальные изменения технического / косметического характера (инфраструктура, рефакторинг, CI, правки стилей и т.п.).
   Если таких изменений нет — блок не добавляй.

## Общие правила

- Пиши на русском языке.
- Группируй похожие изменения в один пункт.
- Каждый пункт основного списка начинается с тире «- » и эмодзи своей категории (🆕 / 👤 / 🔧 / 🐛).
- Каждый пункт в блоке «Технические обновления» начинается с «- » без эмодзи.
- Используй глагол действия: «добавлен», «обновлён», «исправлен», «улучшен», «удалён».
- Для названий инструментов используй ТОЛЬКО следующий справочник. Если в коммите встречается технический slug — заменяй его на человекочитаемое название. Рядом с каждым инструментом указано кто его использует: [спец] = специалисты портала, [клиент] = клиентский доступ.

  done-for-you → Done For You База [спец]
  base-constructor → Конструктор баз [спец]
  ai-caller → AI Звонилка [спец]
  ai-caller-v2 → AI Звонилка v2 [спец]
  databases → Работа с базами [спец]
  database-review → Проверка баз [спец]
  parsers → Парсеры [спец]
  email-sequence → Цепочки писем [спец]
  email-sequence-v2 → Цепочки писем 2.0 [спец]
  auto-report → Автоотчёты [спец]
  audio-transcribe → Расшифровка видео и аудио [спец]
  tg-transcribe → Транскрибации из ТГ [спец]
  cis-lead-finder → CIS Lead Finder [спец]
  li-outreach → LinkedIn Outreach [спец]
  rdp → Удалённый рабочий стол [спец]
  instantly → Instantly [спец]
  tg-outreach → TG Аутрич [спец]
  habr-career → Habr Career [спец]
  tg-parser → TG User Parser [спец]
  sales-copilot → Sales Copilot [спец]
  knowledge-base → База знаний [спец]
  bugor-outreach → Наш бугор аутрич [спец]
  nash-outreach → Наш аутрич [спец]
  reputation-finder → Reputation Finder [спец]
  our-bases → Наша база баз [спец]
  companies-search → Наша база баз [спец]
  atmos-analytics → Atmos-аналитика [спец]
  okved-modal → ОКВЭД справочник [спец]
  client-brief → Бриф клиента [спец]
  client-support → Поддержка клиентов [спец+клиент]
  client → клиентский кабинет [клиент]
  tariff → тарифный план [клиент]
- НИКОГДА не используй markdown-форматирование: никаких бэктиков (`), звёздочек (*), подчёркиваний (_), решёток (#). Только обычный текст.
- Пиши простым, понятным языком — без технических терминов (никаких «идемпотентность», «upsert», «транзакция», «миграция», «рефакторинг» и т.п.). Представь, что читатель — менеджер, а не разработчик.
- Технические детали (SHA, имена файлов, названия веток, номера PR) не включай.
- Коммиты типа Merge branch / Merge pull request / chore / ci / bump — игнорируй или помещай в технический блок только если несут смысл.
- Никогда не упоминай удаление файлов, скриптов,Credentialов, секретов, ключей, паролей — это внутренние технические операции, не нужные читателю.
- Никогда не пиши о том, что что-то «удалено из репозитория», «убрано из кода», «очищено» — такие изменения полностью игнорируй.
- Не добавляй заголовок «Обновления на портале» — только отсортированный список и опциональный технический блок.
- Если все коммиты служебные и нечего показать — ответь пустой строкой.
- Не добавляй никаких пояснений вне списка.
"""


async def summarize_with_ai(messages: list[str]) -> str:
    if not messages:
        return ""

    user_content = "Список коммит-сообщений:\n" + "\n".join(f"- {m}" for m in messages)

    payload = {
        "model": AI_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ],
        "temperature": 0.3,
        "max_tokens": 1500,
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
    if THREAD_ID:
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

async def run_digest() -> None:
    now_msk = datetime.now(MSK)
    weekday = now_msk.weekday()
    print(f"[changelog] run_digest triggered: {now_msk.strftime('%d.%m.%Y %H:%M MSK')} weekday={weekday}", flush=True)

    if weekday >= 5:
        print("[changelog] Weekend — skip.", flush=True)
        return

    since_utc, until_utc = _compute_window(now_msk)
    print(f"[changelog] Window: {since_utc.strftime('%Y-%m-%dT%H:%M:%SZ')} → {until_utc.strftime('%Y-%m-%dT%H:%M:%SZ')}", flush=True)

    if not RUN_NOW and await already_sent(since_utc, until_utc):
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

    summary = await summarize_with_ai(messages)

    if not summary or not summary.strip():
        print("[changelog] AI returned empty summary — nothing to send.", flush=True)
        return

    if weekday == 0:
        period_label = "за прошедшие выходные и пятницу"
    else:
        period_label = "за прошедшие сутки"

    safe_summary = summary.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    text = f"<b>Обновления на портале {period_label}:</b>\n\n{safe_summary}"
    print(f"[changelog] Sending message ({len(text)} chars)...", flush=True)
    ok = await send_message(text)
    print(f"[changelog] Message sent: {ok}", flush=True)
    if ok:
        await save_digest(since_utc, until_utc, summary)


# ── Health check server ───────────────────────────────────────────────────────

async def handle_health(_request: web.Request) -> web.Response:
    return web.json_response({"status": "ok", "service": "changelog-bot"})


# ── Main ──────────────────────────────────────────────────────────────────────

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
    asyncio.run(main())

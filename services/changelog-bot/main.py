"""
Changelog-bot: ежедневный дайджест обновлений портала в Telegram.

Расписание:
  - Каждый день в 9:00 МСК (06:00 UTC), включая выходные.
  - Окно всегда за последние 24 ч (со вчера 9:00 до сегодня 9:00 МСК).
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
import re
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


# ── Ожидание базы при старте ────────────────────────────────────────────────
# После перезагрузки сервера или cgroup-OOM Postgres минуту-две проходит crash
# recovery и отвечает всем «57P03: the database system is in recovery mode».
# Без ожидания сервис падал с exit 1, docker перезапускал, он падал снова —
# loop-watchdog глушил его после 5 падений и ставил restart=no, после чего
# контейнер лежал до ручного подъёма. 13-14.08.2026 так вышло трижды.
DB_WAIT_TIMEOUT_SEC = float(os.environ.get("DB_WAIT_TIMEOUT_SEC", "300"))

# Транзиентное: база поднимается, перегружена или сеть моргнула. Ошибки доступа
# (неверный пароль, отсутствующая роль) сюда намеренно не входят — на них
# сервис обязан падать сразу, а не маскировать опечатку в конфиге ретраями.
_DB_TRANSIENT_ERRORS = (
    asyncpg.CannotConnectNowError,
    asyncpg.TooManyConnectionsError,
    asyncpg.ConnectionDoesNotExistError,
    OSError,  # ConnectionRefusedError, DNS, TLS
    asyncio.TimeoutError,
)


async def wait_for_db(timeout_sec: float = DB_WAIT_TIMEOUT_SEC) -> None:
    """Дождаться, пока Postgres начнёт принимать соединения."""
    if not DATABASE_URL:
        return
    deadline = asyncio.get_running_loop().time() + timeout_sec
    delay = 1.0
    attempt = 0
    while True:
        attempt += 1
        try:
            conn = await asyncpg.connect(
                DATABASE_URL, statement_cache_size=0, timeout=10
            )
            await conn.close()
            if attempt > 1:
                print(f"[changelog] БД доступна с попытки {attempt}", flush=True)
            return
        except _DB_TRANSIENT_ERRORS as e:
            if asyncio.get_running_loop().time() >= deadline:
                print(
                    f"[changelog] БД недоступна {timeout_sec:.0f}с, сдаюсь: {e}",
                    flush=True,
                )
                raise
            print(
                f"[changelog] БД недоступна ({type(e).__name__}), "
                f"повтор через {delay:.0f}с",
                flush=True,
            )
            await asyncio.sleep(delay)
            delay = min(delay * 2, 15.0)


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
    """Return (since, until) in UTC for the reporting window.

    Бот ходит каждый день, поэтому окно всегда ровно сутки: со вчерашних
    9:00 МСК до сегодняшних. Раньше понедельник забирал Пт+Сб+Вс одним куском —
    это давало дайджест на пару тысяч коммитов, который нечитаем."""
    boundary = now_msk.replace(hour=9, minute=0, second=0, microsecond=0)
    since_msk = boundary - timedelta(days=1)
    return since_msk.astimezone(timezone.utc), boundary.astimezone(timezone.utc)


# ── GitHub API ────────────────────────────────────────────────────────────────

# 100 коммитов на страницу × 50 страниц = 5000 коммитов на окно в 1-3 дня.
# Реальный поток — десятки в день, так что это аварийный стоп, а не рабочий лимит.
MAX_COMMIT_PAGES = 50


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

    # Параметры уходят ТОЛЬКО в первый запрос. Дальше идём по готовому
    # `Link: rel="next"`, где since/until/per_page/page уже вшиты в query.
    # Передавать сюда `params={}` нельзя: httpx перезаписывает query целиком,
    # next-ссылка теряет page= и since= → бесконечный цикл по первой странице
    # всей истории репозитория (инцидент 03.08.2026: 150k коммитов, 1 ГБ RSS,
    # выжран часовой лимит GitHub API).
    next_params: dict[str, str] | None = params
    seen_urls: set[str] = set()

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            for _ in range(MAX_COMMIT_PAGES):
                if not url or url in seen_urls:
                    break
                seen_urls.add(url)
                r = await client.get(url, headers=headers, params=next_params)
                next_params = None
                if r.status_code == 200:
                    page = r.json()
                    commits.extend(page)
                    link = r.headers.get("Link", "")
                    next_url = _parse_next_link(link)
                    url = next_url or ""
                else:
                    print(f"[changelog] GitHub API error {r.status_code}: {r.text[:200]}", flush=True)
                    break
            else:
                print(
                    f"[changelog] Pagination stopped at {MAX_COMMIT_PAGES} pages "
                    f"({len(commits)} commits) — окно подозрительно широкое",
                    flush=True,
                )
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


def _is_noise_merge(first_line: str) -> bool:
    """Merge-коммиты веток — не несут смысла для дайджеста и жрут слоты
    из MAX_MESSAGES + токены (`Merge pull request #NNN from wemdio/test`,
    `Merge branch 'test' into main` и т.п.). Настоящие изменения уже лежат
    отдельными коммитами в списке — их фичи модель и опишет.
    Промпт и так велит их игнорировать, но пока они в user_content, они
    оттесняют реальные коммиты за границу лимита."""
    low = first_line.lower()
    return (
        low.startswith("merge pull request ")
        or low.startswith("merge branch ")
        or low.startswith("merge remote-tracking branch ")
    )


def _extract_commit_info(commits: list[dict[str, Any]]) -> list[str]:
    messages: list[str] = []
    skipped_merges = 0
    for c in commits:
        msg: str = c.get("commit", {}).get("message", "").strip()
        if not msg:
            continue
        first_line = msg.splitlines()[0].strip()
        if not first_line:
            continue
        if _is_noise_merge(first_line):
            skipped_merges += 1
            continue
        messages.append(first_line)
    if skipped_merges:
        print(f"[changelog] Skipped {skipped_merges} merge-only commits (branch/PR merges)", flush=True)
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
- Максимум два уровня вложенности: пункт и подпункт с отступом в 2 пробела. Третий уровень запрещён — если материала много, сворачивай его в перечисление внутри подпункта через точку с запятой.
- Используй глагол действия: «добавлен», «обновлён», «исправлен», «улучшен».
- Между блоками — одна пустая строка.
- Название инструмента в начале пункта оборачивай в двойные звёздочки для жирного шрифта: `- **Парсер 2ГИС:** описание изменений.`. Это единственный разрешённый markdown.
- Другой markdown НЕ используй: никаких бэктиков (`), одиночных звёздочек (*курсив*), подчёркиваний (_), решёток (#).
- НЕ ставь горизонтальных разделителей между блоками (--- или *** или ___). Блоки разделяются только пустой строкой.
- Пиши простым языком без технических терминов («идемпотентность», «upsert», «миграция», «рефакторинг» и т.п.).
- Не включай: SHA, имена файлов, названия веток, номера PR.
- Игнорируй коммиты: Merge branch, Merge pull request, а также любые упоминания об удалении файлов, скриптов, секретов, ключей.
- Если все коммиты служебные и нечего показать — ответь пустой строкой.
- Не добавляй никаких пояснений — только блоки с пунктами.
"""


MAX_MESSAGES = 2000
MAX_USER_CONTENT_CHARS = 400_000

# Markdown-разделитель («---», «***», «___», в т.ч. с пробелами между знаками).
# Отдельно от списка: пункт «- текст» под это не подпадает, там после знака идёт текст.
_HR_RE = re.compile(r"^(?:[-*_]\s*){3,}$")


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

# Пункт списка: отступ + маркер + текст. Маркером модель пишет дефис,
# но иногда проскакивает звёздочка или уже готовая «•».
_BULLET_RE = re.compile(r"^(\s*)[-*•]\s+(.*)$")

# Уровня ровно два. Первый — нумерованный (1. 2. 3.), второй — дефис с
# отступом. Один и тот же дефис на всех уровнях сливался в сплошную стену:
# глубину не видно, читать тяжело. Номера дают верхнему уровню опору для глаза.
# Всё, что модель вложит глубже второго уровня, прижимается ко второму —
# третий уровень в мессенджере нечитаем при любых маркерах.
_SUB_BULLET = "   - "


def _render_telegram(summary: str) -> str:
    """Превратить markdown-ответ модели в текст для Telegram (parse_mode=HTML)."""
    escaped = summary.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    # Модель по-прежнему любит писать markdown-жирный **Название**; Telegram с
    # parse_mode=HTML показывает звёздочки как есть. Конвертируем после escape,
    # чтобы <b>…</b> не попали под замену & < >.
    escaped = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", escaped)
    raw_lines = escaped.splitlines()

    lines: list[str] = []
    prev_is_header = False
    # Глубину считаем стеком отступов, а не делением ширины на 4: модель
    # отбивает подпункты то двумя пробелами, то четырьмя, и мешает их в одном
    # ответе. Важна не абсолютная ширина, а «шире/уже предыдущего».
    indent_stack: list[int] = []
    # Нумерация верхнего уровня идёт внутри блока и обнуляется на каждом
    # заголовке — иначе «Прочие технические обновления» продолжали бы счёт
    # с середины предыдущего блока.
    top_number = 0
    for line in raw_lines:
        stripped = line.strip()
        is_header = stripped.endswith(":") and not stripped.startswith("-")
        is_empty = stripped == ""

        # Модель иногда ставит между блоками markdown-разделитель (--- / *** / ___).
        # Telegram в HTML-режиме рисует его как есть — три голых минуса посреди
        # дайджеста. Блоки и так разделены пустой строкой, так что просто выкидываем.
        if _HR_RE.match(stripped):
            continue

        if is_empty and prev_is_header:
            prev_is_header = False
            continue

        # Разделитель мог унести с собой соседнюю пустую строку — не оставляем
        # двойных пустых строк (и пустой строки в самом начале) на его месте.
        if is_empty and (not lines or lines[-1].strip() == ""):
            continue

        if is_header:
            lines.append(f"<b>{stripped}</b>")
            prev_is_header = True
            top_number = 0
            indent_stack = []
            continue

        prev_is_header = False
        bullet = _BULLET_RE.match(line)
        if bullet:
            width = len(bullet.group(1).expandtabs(4))
            while indent_stack and width < indent_stack[-1]:
                indent_stack.pop()
            if not indent_stack or width > indent_stack[-1]:
                indent_stack.append(width)
            text_part = bullet.group(2).strip()
            if len(indent_stack) == 1:
                top_number += 1
                lines.append(f"{top_number}. {text_part}")
            else:
                lines.append(f"{_SUB_BULLET}{text_part}")
        else:
            lines.append(line)

    return "\n".join(lines)


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
    days_override: int | None = None,
    model_override: str | None = None,
    skip_already_sent_check: bool = False,
) -> None:
    now_msk = datetime.now(MSK)
    print(f"[changelog] run_digest triggered: {now_msk.strftime('%d.%m.%Y %H:%M MSK')} weekday={now_msk.weekday()}", flush=True)

    if days_override is not None:
        until_utc = datetime.now(timezone.utc)
        since_utc = until_utc - timedelta(days=days_override)
        period_label = f"за последние {days_override} дн."
    else:
        since_utc, until_utc = _compute_window(now_msk)
        period_label = "за прошедшие сутки"

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

    text = _render_telegram(summary)
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
    """При старте проверяем: если уже после 9:00 МСК и саммари за текущее
    окно ещё не отправлялось — запускаем дайджест."""
    now_msk = datetime.now(MSK)

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
        days_override=days,
        model_override=model,
        skip_already_sent_check=True,
    )


async def main() -> None:
    _require("CHANGELOG_BOT_TOKEN", TELEGRAM_BOT_TOKEN)
    _require("CHANGELOG_CHAT_ID", CHAT_ID)
    _require("REQUESTY_CHANGELOG_API_KEY", OPENROUTER_API_KEY)

    await wait_for_db()
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
        CronTrigger(hour=6, minute=0, timezone="UTC"),
        id="daily_digest",
        max_instances=1,
    )
    scheduler.start()
    print(f"[changelog] Scheduled: daily at 09:00 MSK (06:00 UTC). Repo: {GITHUB_REPO}, model: {AI_MODEL}", flush=True)

    while True:
        await asyncio.sleep(3600)


if __name__ == "__main__":
    args = _parse_args()
    if args.once:
        asyncio.run(run_once(days=args.days, model=args.model))
    else:
        asyncio.run(main())

"""
Atmos-bot: Telegram chat atmosphere analyzer.

Webhook server (aiohttp):
  - Receives all messages from chats where the bot is added.
  - Stores them in tg_atmos_messages for later analysis.
  - Handles admin commands in private chat (/settings, /model, /chats, etc.)

Scheduled analysis (every N min, configurable):
  - For each tracked chat, fetches unprocessed messages.
  - Sends the batch to OpenRouter LLM for sentiment classification.
  - If negativity ratio >= threshold -> immediate alert to team chat.
  - Saves results to tg_atmos_checks.

Hourly summary (interval configurable):
  - Aggregates last-hour checks across all chats.
  - Posts a digest to the team chat.

All runtime settings (model, thresholds, intervals) are stored in DB
and can be changed via Telegram commands without restart.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from dataclasses import dataclass
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

# ── Env config (immutable, set once) ────────────────────────────────────────

DATABASE_URL = os.environ.get("DATABASE_URL") or os.environ.get("SUPABASE_DB_URL")
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_ATMOS_BOT_TOKEN")
TEAM_CHAT_ID = os.environ.get("TELEGRAM_ATMOS_TEAM_CHAT_ID")
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_ATMOS_API_KEY")

WEBHOOK_PORT = int(os.environ.get("ATMOS_WEBHOOK_PORT", "8090"))
WEBHOOK_PATH = os.environ.get("ATMOS_WEBHOOK_PATH", "/webhook")

MSK = timezone(timedelta(hours=3))
MAX_BATCH_SIZE = 80

DEFAULT_SYSTEM_PROMPT = """Ты — аналитик атмосферы в чате B2B‑компании, который следит за перепиской с клиентами.

Твоя задача — по пачке сообщений оценить общую атмосферу и риски для отношений с клиентом.

Отвечай ТОЛЬКО валидным JSON (БЕЗ markdown‑обёрток, без комментариев):
{
  "total_analyzed": <int>,                           // сколько сообщений проанализировано
  "negative_count": <int>,                           // сколько из них отнесено к негативным
  "sentiment_score": <float 0.0-1.0>,                // 0.0 = очень негативно, 1.0 = очень позитивно
  "risk_level": "low" | "medium" | "high" | "critical",
  "negative_reasons": ["<краткая причина>", ...],    // список коротких формулировок причин негатива
  "recommended_action": "<краткий совет или 'none'>",
  "summary": "<1–2 предложения краткого вывода по атмосфере>"
}

Правила:
- Считай сообщение негативным, если в нём есть недовольство, жалоба, раздражение, злость, разочарование,
  угроза уйти к конкурентам, обвинения, пассивная агрессия или саркастичные наезды в сторону сервиса.
- Нейтральные вопросы, уточнения, благодарности и позитив — НЕ считаются негативом.
- Будь особенно внимателен к русскому языку: сарказм, пассивная агрессия, «подколы», скрытое недовольство.
- Если негативных сообщений нет, "negative_reasons" должен быть пустым массивом [].
"""

AVAILABLE_MODELS = [
    ("google/gemini-2.0-flash-001", "Gemini 2.0 Flash — дёшево, быстро"),
    ("google/gemini-2.5-flash-preview", "Gemini 2.5 Flash Preview — новее"),
    ("meta-llama/llama-3.3-70b-instruct", "Llama 3.3 70B — мощнее"),
    ("qwen/qwen-2.5-72b-instruct", "Qwen 2.5 72B — альтернатива"),
    ("deepseek/deepseek-chat-v3-0324", "DeepSeek V3 — дёшево"),
]


def _require(name: str, val: str | None) -> str:
    if not val:
        print(f"[atmos] FATAL: {name} not set")
        sys.exit(1)
    return val


def _now_msk() -> str:
    return datetime.now(MSK).strftime("%d.%m.%Y %H:%M MSK")


def _escape_html(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# ── Runtime config (mutable, loaded from DB) ───────────────────────────────

@dataclass
class RuntimeConfig:
    model: str = "google/gemini-2.0-flash-001"
    check_interval_sec: int = 300
    stats_interval_sec: int = 3600
    negative_threshold: float = 0.30
    system_prompt: str = ""


_cfg = RuntimeConfig()
_scheduler: AsyncIOScheduler | None = None


async def load_config_from_db() -> None:
    pool = await get_pool()
    row = await pool.fetchrow("SELECT model, check_interval_sec, stats_interval_sec, negative_threshold, system_prompt FROM tg_atmos_settings WHERE id = 1")
    if row:
        _cfg.model = row["model"]
        _cfg.check_interval_sec = row["check_interval_sec"]
        _cfg.stats_interval_sec = row["stats_interval_sec"]
        _cfg.negative_threshold = row["negative_threshold"]
        _cfg.system_prompt = row["system_prompt"] or ""
    print(f"[atmos] Config loaded: model={_cfg.model}, check={_cfg.check_interval_sec}s, stats={_cfg.stats_interval_sec}s, threshold={_cfg.negative_threshold:.0%}")


async def save_config_to_db(**kwargs: Any) -> None:
    pool = await get_pool()
    sets: list[str] = []
    vals: list[Any] = []
    idx = 1
    for key, val in kwargs.items():
        if key in ("model", "check_interval_sec", "stats_interval_sec", "negative_threshold", "system_prompt"):
            sets.append(f"{key} = ${idx}")
            vals.append(val)
            idx += 1
            setattr(_cfg, key, val)
    if not sets:
        return
    sets.append(f"updated_at = ${idx}")
    vals.append(datetime.now(timezone.utc))
    query = f"UPDATE tg_atmos_settings SET {', '.join(sets)} WHERE id = 1"
    await pool.execute(query, *vals)


def _reschedule_jobs() -> None:
    if not _scheduler:
        return
    try:
        _scheduler.reschedule_job("analysis", trigger="interval", seconds=_cfg.check_interval_sec)
    except Exception as e:
        print(f"[atmos] reschedule analysis error: {e}")
    try:
        _scheduler.reschedule_job("hourly", trigger="interval", seconds=_cfg.stats_interval_sec)
    except Exception as e:
        print(f"[atmos] reschedule hourly error: {e}")


# ── DB pool (lazy init) ────────────────────────────────────────────────────

_pool: asyncpg.Pool | None = None


async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=5)
    return _pool


# ── Telegram helpers ────────────────────────────────────────────────────────

async def tg_api(method: str, payload: dict[str, Any]) -> dict[str, Any] | None:
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/{method}"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(url, json=payload)
            data = r.json()
            if not data.get("ok"):
                print(f"[atmos] TG {method} error: {data.get('description', r.text[:200])}")
            return data
    except Exception as e:
        print(f"[atmos] TG {method} exception: {e}")
        return None


async def send_team_message(text: str) -> bool:
    if not TELEGRAM_BOT_TOKEN or not TEAM_CHAT_ID:
        return False
    result = await tg_api("sendMessage", {
        "chat_id": TEAM_CHAT_ID,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    })
    return bool(result and result.get("ok"))


async def _reply(chat_id: int, text: str, reply_markup: dict | None = None) -> None:
    payload: dict[str, Any] = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    if reply_markup:
        payload["reply_markup"] = reply_markup
    await tg_api("sendMessage", payload)


async def _answer_callback(callback_query_id: str, text: str = "") -> None:
    payload: dict[str, Any] = {"callback_query_id": callback_query_id}
    if text:
        payload["text"] = text
        payload["show_alert"] = False
    await tg_api("answerCallbackQuery", payload)


async def _edit_message(chat_id: int, message_id: int, text: str, reply_markup: dict | None = None) -> None:
    payload: dict[str, Any] = {
        "chat_id": chat_id,
        "message_id": message_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    if reply_markup:
        payload["reply_markup"] = reply_markup
    await tg_api("editMessageText", payload)


def build_chat_link(chat_id: int, username: str | None, title: str) -> str:
    if username:
        return f'<a href="https://t.me/{username}">{_escape_html(title)}</a>'
    return f"<b>{_escape_html(title)}</b> (id: <code>{chat_id}</code>)"


# ── Admin command handlers (private chat) ──────────────────────────────────

async def cmd_start(chat_id: int) -> None:
    text = (
        "👋 <b>Atmos-bot</b> — анализатор атмосферы в чатах\n\n"
        "Добавьте меня в групповые чаты с клиентами, "
        "и я буду следить за тональностью общения.\n\n"
        "<b>Команды:</b>\n"
        "/settings — текущие настройки\n"
        "/model — выбрать модель ИИ\n"
        "/threshold — порог негатива для алертов\n"
        "/interval — интервалы анализа и сводки\n"
        "/prompt — системный промпт для ИИ\n"
        "/chats — список отслеживаемых чатов\n"
        "/status — статус бота и последний анализ"
    )
    await _reply(chat_id, text)


async def cmd_settings(chat_id: int) -> None:
    text = (
        f"⚙️ <b>Текущие настройки</b>\n\n"
        f"🤖 Модель: <code>{_escape_html(_cfg.model)}</code>\n"
        f"⏱ Анализ: каждые <b>{_cfg.check_interval_sec // 60}</b> мин\n"
        f"📊 Сводка: каждые <b>{_cfg.stats_interval_sec // 60}</b> мин\n"
        f"🎯 Порог негатива: <b>{_cfg.negative_threshold:.0%}</b>\n"
        f"📝 Промпт: <b>{'кастомный' if _cfg.system_prompt else 'по умолчанию'}</b>\n\n"
        f"Используйте /model, /threshold, /interval, /prompt для изменения."
    )
    await _reply(chat_id, text)


async def cmd_model(chat_id: int) -> None:
    buttons = []
    for model_id, label in AVAILABLE_MODELS:
        current = " ✅" if model_id == _cfg.model else ""
        buttons.append([{"text": f"{label}{current}", "callback_data": f"model:{model_id}"}])

    text = "🤖 <b>Выберите модель для анализа:</b>"
    await _reply(chat_id, text, reply_markup={"inline_keyboard": buttons})


async def cb_model_select(chat_id: int, message_id: int, callback_id: str, model_id: str) -> None:
    known = {m[0] for m in AVAILABLE_MODELS}
    if model_id not in known:
        await _answer_callback(callback_id, "Неизвестная модель")
        return

    await save_config_to_db(model=model_id)
    await _answer_callback(callback_id, f"Модель изменена")

    label = next((l for m, l in AVAILABLE_MODELS if m == model_id), model_id)
    buttons = []
    for mid, mlabel in AVAILABLE_MODELS:
        current = " ✅" if mid == model_id else ""
        buttons.append([{"text": f"{mlabel}{current}", "callback_data": f"model:{mid}"}])

    text = f"🤖 <b>Выберите модель для анализа:</b>\n\nТекущая: <code>{_escape_html(model_id)}</code>"
    await _edit_message(chat_id, message_id, text, reply_markup={"inline_keyboard": buttons})


async def cmd_threshold(chat_id: int) -> None:
    options = [10, 20, 30, 40, 50]
    buttons = []
    row: list[dict[str, str]] = []
    for pct in options:
        current = " ✅" if abs(_cfg.negative_threshold - pct / 100) < 0.01 else ""
        row.append({"text": f"{pct}%{current}", "callback_data": f"thresh:{pct}"})
        if len(row) == 3:
            buttons.append(row)
            row = []
    if row:
        buttons.append(row)

    text = f"🎯 <b>Порог негатива для алерта</b>\n\nТекущий: <b>{_cfg.negative_threshold:.0%}</b>\nВыберите новый:"
    await _reply(chat_id, text, reply_markup={"inline_keyboard": buttons})


async def cb_threshold_select(chat_id: int, message_id: int, callback_id: str, pct_str: str) -> None:
    try:
        pct = int(pct_str)
    except ValueError:
        await _answer_callback(callback_id, "Ошибка")
        return

    new_val = pct / 100.0
    await save_config_to_db(negative_threshold=new_val)
    await _answer_callback(callback_id, f"Порог: {pct}%")

    options = [10, 20, 30, 40, 50]
    buttons = []
    row: list[dict[str, str]] = []
    for o in options:
        current = " ✅" if o == pct else ""
        row.append({"text": f"{o}%{current}", "callback_data": f"thresh:{o}"})
        if len(row) == 3:
            buttons.append(row)
            row = []
    if row:
        buttons.append(row)

    text = f"🎯 <b>Порог негатива для алерта</b>\n\nТекущий: <b>{pct}%</b>"
    await _edit_message(chat_id, message_id, text, reply_markup={"inline_keyboard": buttons})


async def cmd_interval(chat_id: int) -> None:
    check_options = [1, 3, 5, 10, 15]
    stats_options = [30, 60, 120, 180]

    check_buttons: list[dict[str, str]] = []
    for mins in check_options:
        current = " ✅" if _cfg.check_interval_sec == mins * 60 else ""
        check_buttons.append({"text": f"{mins}м{current}", "callback_data": f"check_int:{mins}"})

    stats_buttons: list[dict[str, str]] = []
    for mins in stats_options:
        current = " ✅" if _cfg.stats_interval_sec == mins * 60 else ""
        label = f"{mins // 60}ч" if mins >= 60 else f"{mins}м"
        stats_buttons.append({"text": f"{label}{current}", "callback_data": f"stats_int:{mins}"})

    text = (
        f"⏱ <b>Интервалы</b>\n\n"
        f"Анализ: каждые <b>{_cfg.check_interval_sec // 60}</b> мин\n"
        f"Сводка: каждые <b>{_cfg.stats_interval_sec // 60}</b> мин\n\n"
        f"<b>Интервал анализа:</b>"
    )
    await _reply(chat_id, text, reply_markup={"inline_keyboard": [check_buttons, stats_buttons]})


async def cb_check_interval(chat_id: int, message_id: int, callback_id: str, mins_str: str) -> None:
    try:
        mins = int(mins_str)
    except ValueError:
        await _answer_callback(callback_id, "Ошибка")
        return

    await save_config_to_db(check_interval_sec=mins * 60)
    _reschedule_jobs()
    await _answer_callback(callback_id, f"Анализ: каждые {mins} мин")

    check_options = [1, 3, 5, 10, 15]
    stats_options = [30, 60, 120, 180]

    check_buttons: list[dict[str, str]] = []
    for m in check_options:
        current = " ✅" if m == mins else ""
        check_buttons.append({"text": f"{m}м{current}", "callback_data": f"check_int:{m}"})

    stats_buttons: list[dict[str, str]] = []
    for m in stats_options:
        current = " ✅" if _cfg.stats_interval_sec == m * 60 else ""
        label = f"{m // 60}ч" if m >= 60 else f"{m}м"
        stats_buttons.append({"text": f"{label}{current}", "callback_data": f"stats_int:{m}"})

    text = (
        f"⏱ <b>Интервалы</b>\n\n"
        f"Анализ: каждые <b>{mins}</b> мин\n"
        f"Сводка: каждые <b>{_cfg.stats_interval_sec // 60}</b> мин"
    )
    await _edit_message(chat_id, message_id, text, reply_markup={"inline_keyboard": [check_buttons, stats_buttons]})


async def cb_stats_interval(chat_id: int, message_id: int, callback_id: str, mins_str: str) -> None:
    try:
        mins = int(mins_str)
    except ValueError:
        await _answer_callback(callback_id, "Ошибка")
        return

    await save_config_to_db(stats_interval_sec=mins * 60)
    _reschedule_jobs()
    await _answer_callback(callback_id, f"Сводка: каждые {mins} мин")

    check_options = [1, 3, 5, 10, 15]
    stats_options = [30, 60, 120, 180]

    check_buttons: list[dict[str, str]] = []
    for m in check_options:
        current = " ✅" if _cfg.check_interval_sec == m * 60 else ""
        check_buttons.append({"text": f"{m}м{current}", "callback_data": f"check_int:{m}"})

    stats_buttons: list[dict[str, str]] = []
    for m in stats_options:
        current = " ✅" if m == mins else ""
        label = f"{m // 60}ч" if m >= 60 else f"{m}м"
        stats_buttons.append({"text": f"{label}{current}", "callback_data": f"stats_int:{m}"})

    label = f"{mins // 60}ч" if mins >= 60 else f"{mins}м"
    text = (
        f"⏱ <b>Интервалы</b>\n\n"
        f"Анализ: каждые <b>{_cfg.check_interval_sec // 60}</b> мин\n"
        f"Сводка: каждые <b>{label}</b>"
    )
    await _edit_message(chat_id, message_id, text, reply_markup={"inline_keyboard": [check_buttons, stats_buttons]})


async def cmd_chats(chat_id: int) -> None:
    pool = await get_pool()
    chats = await pool.fetch(
        """
        SELECT cs.chat_id, cs.chat_title, cs.chat_username, cs.last_processed_message_id,
               (SELECT count(*) FROM tg_atmos_messages m WHERE m.chat_id = cs.chat_id) AS msg_count,
               (SELECT count(*) FROM tg_atmos_checks c WHERE c.chat_id = cs.chat_id) AS check_count
        FROM tg_atmos_chat_state cs
        ORDER BY cs.chat_title
        """
    )

    if not chats:
        await _reply(chat_id, "📋 <b>Отслеживаемые чаты</b>\n\nПока нет чатов. Добавьте бота в групповой чат.")
        return

    lines: list[str] = []
    for c in chats:
        link = build_chat_link(c["chat_id"], c["chat_username"], c["chat_title"] or "Unknown")
        lines.append(
            f"  • {link}\n"
            f"    Сообщений: {c['msg_count']}  |  Проверок: {c['check_count']}"
        )

    text = f"📋 <b>Отслеживаемые чаты</b> ({len(chats)})\n\n" + "\n\n".join(lines)
    await _reply(chat_id, text)


async def cmd_status(chat_id: int) -> None:
    pool = await get_pool()

    chat_count = await pool.fetchval("SELECT count(*) FROM tg_atmos_chat_state") or 0
    msg_count = await pool.fetchval("SELECT count(*) FROM tg_atmos_messages") or 0
    unprocessed = await pool.fetchval("SELECT count(*) FROM tg_atmos_messages WHERE processed_at IS NULL") or 0
    check_count = await pool.fetchval("SELECT count(*) FROM tg_atmos_checks") or 0

    last_check = await pool.fetchrow(
        "SELECT chat_id, created_at, risk_level, summary FROM tg_atmos_checks ORDER BY created_at DESC LIMIT 1"
    )

    last_section = "Нет данных"
    if last_check:
        chat_row = await pool.fetchrow(
            "SELECT chat_title FROM tg_atmos_chat_state WHERE chat_id = $1", last_check["chat_id"]
        )
        chat_name = (chat_row["chat_title"] if chat_row else "Unknown")
        ts = last_check["created_at"]
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        last_section = (
            f"{_escape_html(chat_name)} — {last_check['risk_level']}\n"
            f"    {_escape_html(last_check['summary'] or '-')}\n"
            f"    {ts.astimezone(MSK).strftime('%d.%m %H:%M MSK')}"
        )

    text = (
        f"📈 <b>Статус Atmos-bot</b>\n\n"
        f"Чатов: <b>{chat_count}</b>\n"
        f"Сообщений: <b>{msg_count}</b> (необработанных: {unprocessed})\n"
        f"Проверок: <b>{check_count}</b>\n\n"
        f"<b>Последняя проверка:</b>\n  {last_section}\n\n"
        f"<b>Конфиг:</b>\n"
        f"  Модель: <code>{_escape_html(_cfg.model)}</code>\n"
        f"  Анализ: каждые {_cfg.check_interval_sec // 60} мин\n"
        f"  Сводка: каждые {_cfg.stats_interval_sec // 60} мин\n"
        f"  Порог: {_cfg.negative_threshold:.0%}\n\n"
        f"🕐 {_now_msk()}"
    )
    await _reply(chat_id, text)


# ── Webhook handler ────────────────────────────────────────────────────────

@dataclass(frozen=True)
class IncomingMessage:
    chat_id: int
    message_id: int
    sender_name: str
    sender_id: int
    text: str
    chat_title: str
    chat_username: str | None
    chat_type: str
    sent_at: datetime


def _extract_sender_name(msg: dict[str, Any]) -> str:
    frm = msg.get("from", {})
    parts = [frm.get("first_name", ""), frm.get("last_name", "")]
    name = " ".join(p for p in parts if p)
    return name or f"User {frm.get('id', 0)}"


def _parse_group_message(update: dict[str, Any]) -> IncomingMessage | None:
    msg = update.get("message")
    if not msg:
        return None

    chat = msg.get("chat", {})
    chat_type = chat.get("type", "")
    if chat_type not in ("group", "supergroup"):
        return None

    text = msg.get("text") or msg.get("caption") or ""
    if not text.strip():
        return None

    date_unix = msg.get("date", 0)
    sent_at = datetime.fromtimestamp(date_unix, tz=timezone.utc) if date_unix else datetime.now(timezone.utc)

    return IncomingMessage(
        chat_id=chat.get("id", 0),
        message_id=msg.get("message_id", 0),
        sender_name=_extract_sender_name(msg),
        sender_id=msg.get("from", {}).get("id", 0),
        text=text.strip(),
        chat_title=chat.get("title", "Unknown"),
        chat_username=chat.get("username"),
        chat_type=chat_type,
        sent_at=sent_at,
    )


async def _save_message(parsed: IncomingMessage) -> None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO tg_atmos_messages
                (chat_id, message_id, sender_id, sender_name, text, chat_title, chat_username, sent_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (chat_id, message_id) DO NOTHING
            """,
            parsed.chat_id,
            parsed.message_id,
            parsed.sender_id,
            parsed.sender_name,
            parsed.text,
            parsed.chat_title,
            parsed.chat_username,
            parsed.sent_at,
        )

        # Keep per-user metadata up to date for analytics
        await conn.execute(
            """
            INSERT INTO tg_atmos_users (user_id, full_name, last_message_at)
            VALUES ($1, $2, $3)
            ON CONFLICT (user_id) DO UPDATE SET
                full_name       = EXCLUDED.full_name,
                last_message_at = EXCLUDED.last_message_at
            """,
            parsed.sender_id,
            parsed.sender_name,
            parsed.sent_at,
        )


async def _upsert_chat_state(parsed: IncomingMessage) -> None:
    pool = await get_pool()
    await pool.execute(
        """
        INSERT INTO tg_atmos_chat_state (chat_id, chat_title, chat_username)
        VALUES ($1, $2, $3)
        ON CONFLICT (chat_id) DO UPDATE SET
            chat_title = EXCLUDED.chat_title,
            chat_username = COALESCE(EXCLUDED.chat_username, tg_atmos_chat_state.chat_username)
        """,
        parsed.chat_id,
        parsed.chat_title,
        parsed.chat_username,
    )


def _extract_private_command(update: dict[str, Any]) -> tuple[int, str] | None:
    """Returns (chat_id, command_text) if this is a private-chat text message."""
    msg = update.get("message")
    if not msg:
        return None
    chat = msg.get("chat", {})
    if chat.get("type") != "private":
        return None
    text = (msg.get("text") or "").strip()
    if not text:
        return None
    return chat.get("id", 0), text


def _extract_callback(update: dict[str, Any]) -> tuple[int, int, str, str] | None:
    """Returns (chat_id, message_id, callback_id, data) for inline button presses."""
    cb = update.get("callback_query")
    if not cb:
        return None
    msg = cb.get("message", {})
    chat = msg.get("chat", {})
    return (
        chat.get("id", 0),
        msg.get("message_id", 0),
        cb.get("id", ""),
        cb.get("data", ""),
    )


# ── Prompt editing ──────────────────────────────────────────────────────────

_awaiting_prompt: set[int] = set()


def _get_effective_prompt() -> str:
    return _cfg.system_prompt if _cfg.system_prompt else DEFAULT_SYSTEM_PROMPT


async def cmd_prompt(chat_id: int) -> None:
    prompt = _get_effective_prompt()
    is_custom = bool(_cfg.system_prompt)
    status = "✏️ <b>Кастомный</b>" if is_custom else "📄 <b>По умолчанию</b>"

    preview = _escape_html(prompt[:500])
    if len(prompt) > 500:
        preview += "…"

    buttons = [
        [{"text": "✏️ Редактировать", "callback_data": "prompt:edit"}],
    ]
    if is_custom:
        buttons.append([{"text": "🔄 Сбросить к дефолту", "callback_data": "prompt:reset"}])
    buttons.append([{"text": "📋 Показать полный промпт", "callback_data": "prompt:full"}])

    text = (
        f"📝 <b>Системный промпт</b>\n\n"
        f"Статус: {status}\n\n"
        f"<pre>{preview}</pre>"
    )
    await _reply(chat_id, text, reply_markup={"inline_keyboard": buttons})


async def cb_prompt_edit(chat_id: int, message_id: int, callback_id: str) -> None:
    _awaiting_prompt.add(chat_id)
    await _answer_callback(callback_id, "Отправьте новый промпт")

    text = (
        "✏️ <b>Отправьте новый системный промпт</b>\n\n"
        "Отправьте текст следующим сообщением. "
        "Промпт должен содержать инструкцию для ИИ по анализу сообщений.\n\n"
        "⚠️ Промпт обязательно должен требовать ответ в JSON-формате "
        "с полями: total_analyzed, negative_count, sentiment_score, "
        "risk_level, negative_reasons, recommended_action, summary.\n\n"
        "Отправьте /cancel для отмены."
    )
    await _edit_message(chat_id, message_id, text)


async def cb_prompt_reset(chat_id: int, message_id: int, callback_id: str) -> None:
    await save_config_to_db(system_prompt="")
    await _answer_callback(callback_id, "Промпт сброшен")

    text = "✅ Системный промпт сброшен к значению по умолчанию."
    await _edit_message(chat_id, message_id, text)


async def cb_prompt_full(chat_id: int, message_id: int, callback_id: str) -> None:
    await _answer_callback(callback_id)
    prompt = _get_effective_prompt()

    chunks = []
    remaining = prompt
    while remaining:
        if len(remaining) <= 3800:
            chunks.append(remaining)
            break
        split_at = remaining.rfind("\n", 0, 3800)
        if split_at < 100:
            split_at = 3800
        chunks.append(remaining[:split_at])
        remaining = remaining[split_at:].lstrip()

    for i, chunk in enumerate(chunks):
        header = f"📝 <b>Промпт ({i + 1}/{len(chunks)})</b>\n\n" if len(chunks) > 1 else "📝 <b>Полный промпт:</b>\n\n"
        await _reply(chat_id, f"{header}<pre>{_escape_html(chunk)}</pre>")


async def _handle_prompt_input(chat_id: int, text: str) -> None:
    _awaiting_prompt.discard(chat_id)

    if text.strip().lower() == "/cancel":
        await _reply(chat_id, "❌ Редактирование промпта отменено.")
        return

    if len(text) < 50:
        await _reply(chat_id, "⚠️ Промпт слишком короткий (минимум 50 символов). Попробуйте снова через /prompt")
        return

    if len(text) > 10000:
        await _reply(chat_id, "⚠️ Промпт слишком длинный (максимум 10 000 символов). Сократите и попробуйте через /prompt")
        return

    await save_config_to_db(system_prompt=text)

    await _reply(
        chat_id,
        f"✅ <b>Системный промпт обновлён</b>\n\n"
        f"Длина: {len(text)} символов\n"
        f"Будет использован при следующем анализе.\n\n"
        f"Проверить: /prompt"
    )


COMMANDS: dict[str, Any] = {
    "/start": cmd_start,
    "/settings": cmd_settings,
    "/model": cmd_model,
    "/threshold": cmd_threshold,
    "/interval": cmd_interval,
    "/chats": cmd_chats,
    "/status": cmd_status,
    "/prompt": cmd_prompt,
    "/help": cmd_start,
}


async def handle_webhook(request: web.Request) -> web.Response:
    try:
        update = await request.json()
    except Exception:
        return web.json_response({"ok": True})

    # 1. Callback query (inline button press)
    cb_data = _extract_callback(update)
    if cb_data:
        chat_id, message_id, callback_id, data = cb_data
        try:
            if data.startswith("model:"):
                await cb_model_select(chat_id, message_id, callback_id, data[6:])
            elif data.startswith("thresh:"):
                await cb_threshold_select(chat_id, message_id, callback_id, data[7:])
            elif data.startswith("check_int:"):
                await cb_check_interval(chat_id, message_id, callback_id, data[10:])
            elif data.startswith("stats_int:"):
                await cb_stats_interval(chat_id, message_id, callback_id, data[10:])
            elif data == "prompt:edit":
                await cb_prompt_edit(chat_id, message_id, callback_id)
            elif data == "prompt:reset":
                await cb_prompt_reset(chat_id, message_id, callback_id)
            elif data == "prompt:full":
                await cb_prompt_full(chat_id, message_id, callback_id)
            else:
                await _answer_callback(callback_id)
        except Exception as e:
            print(f"[atmos] callback error: {e}")
            await _answer_callback(callback_id, "Ошибка")
        return web.json_response({"ok": True})

    # 2. Private chat command or prompt input
    private = _extract_private_command(update)
    if private:
        chat_id, text = private

        if chat_id in _awaiting_prompt and not text.startswith("/"):
            try:
                await _handle_prompt_input(chat_id, text)
            except Exception as e:
                print(f"[atmos] prompt input error: {e}")
                _awaiting_prompt.discard(chat_id)
                await _reply(chat_id, "❌ Ошибка при сохранении промпта.")
            return web.json_response({"ok": True})

        if text.strip().lower() == "/cancel" and chat_id in _awaiting_prompt:
            _awaiting_prompt.discard(chat_id)
            await _reply(chat_id, "❌ Редактирование промпта отменено.")
            return web.json_response({"ok": True})

        cmd = text.split()[0].split("@")[0].lower()
        handler = COMMANDS.get(cmd)
        if handler:
            _awaiting_prompt.discard(chat_id)
            try:
                await handler(chat_id)
            except Exception as e:
                print(f"[atmos] command error: {e}")
                await _reply(chat_id, "❌ Ошибка при выполнении команды.")
        return web.json_response({"ok": True})

    # 3. Group message -> save for analysis (skip team chat — it only receives alerts)
    parsed = _parse_group_message(update)
    if parsed and parsed.chat_id and parsed.message_id:
        try:
            team_id: int | None = int(TEAM_CHAT_ID) if TEAM_CHAT_ID else None
            if team_id is not None and parsed.chat_id == team_id:
                return web.json_response({"ok": True})
            await _save_message(parsed)
            await _upsert_chat_state(parsed)
        except Exception as e:
            print(f"[atmos] save error: {e}")

    return web.json_response({"ok": True})


async def handle_health(_request: web.Request) -> web.Response:
    return web.json_response({"status": "ok", "service": "atmos-bot"})


# ── LLM analysis ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class AnalysisResult:
    total_analyzed: int
    negative_count: int
    sentiment_score: float
    risk_level: str
    negative_reasons: list[str]
    recommended_action: str
    summary: str


async def analyze_messages(messages: list[dict[str, str]]) -> AnalysisResult | None:
    if not messages:
        return None

    conversation_text = "\n".join(
        f"[{m['sender']}]: {m['text']}" for m in messages
    )

    user_prompt = f"Analyze these {len(messages)} messages from a client chat:\n\n{conversation_text}"

    payload = {
        "model": _cfg.model,
        "messages": [
            {"role": "system", "content": _get_effective_prompt()},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.1,
        "max_tokens": 1000,
        "response_format": {"type": "json_object"},
    }

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                    "HTTP-Referer": "https://portal.app",
                    "X-Title": "Portal - Atmos Bot",
                },
                json=payload,
            )

            if not r.is_success:
                print(f"[atmos] OpenRouter error {r.status_code}: {r.text[:300]}")
                return None

            data = r.json()
            content = data.get("choices", [{}])[0].get("message", {}).get("content", "")

            parsed = json.loads(content)
            return AnalysisResult(
                total_analyzed=int(parsed.get("total_analyzed", len(messages))),
                negative_count=int(parsed.get("negative_count", 0)),
                sentiment_score=float(parsed.get("sentiment_score", 0.5)),
                risk_level=str(parsed.get("risk_level", "low")),
                negative_reasons=list(parsed.get("negative_reasons", [])),
                recommended_action=str(parsed.get("recommended_action", "none")),
                summary=str(parsed.get("summary", "")),
            )

    except json.JSONDecodeError as e:
        print(f"[atmos] LLM JSON parse error: {e}")
        return None
    except Exception as e:
        print(f"[atmos] LLM call error: {e}")
        return None


# ── 5-minute analysis cycle ────────────────────────────────────────────────

async def run_analysis_cycle() -> None:
    pool = await get_pool()

    chats = await pool.fetch(
        "SELECT chat_id, chat_title, chat_username, last_processed_message_id FROM tg_atmos_chat_state"
    )

    if not chats:
        print("[atmos] No chats to analyze")
        return

    team_id: int | None = int(TEAM_CHAT_ID) if TEAM_CHAT_ID else None

    for chat in chats:
        chat_id: int = chat["chat_id"]
        if team_id is not None and chat_id == team_id:
            continue  # skip team chat — only destination for alerts
        title: str = chat["chat_title"] or "Unknown"
        username: str | None = chat["chat_username"]
        last_processed: int = chat["last_processed_message_id"] or 0

        rows = await pool.fetch(
            """
            SELECT message_id, sender_name, text
            FROM tg_atmos_messages
            WHERE chat_id = $1 AND message_id > $2
            ORDER BY message_id ASC
            LIMIT $3
            """,
            chat_id, last_processed, MAX_BATCH_SIZE,
        )

        if not rows:
            continue

        messages = [
            {"sender": row["sender_name"], "text": row["text"]}
            for row in rows
        ]

        result = await analyze_messages(messages)
        if not result:
            print(f"[atmos] Analysis failed for chat {chat_id} ({title})")
            continue

        max_message_id = max(row["message_id"] for row in rows)

        await pool.execute(
            """
            INSERT INTO tg_atmos_checks
                (chat_id, window_from, window_to, total_count, negative_count,
                 sentiment_score, risk_level, reasons, recommended_action, summary)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            """,
            chat_id,
            last_processed + 1,
            max_message_id,
            result.total_analyzed,
            result.negative_count,
            result.sentiment_score,
            result.risk_level,
            json.dumps(result.negative_reasons, ensure_ascii=False),
            result.recommended_action,
            result.summary,
        )

        await pool.execute(
            """
            UPDATE tg_atmos_chat_state
            SET last_processed_message_id = $2
            WHERE chat_id = $1
            """,
            chat_id, max_message_id,
        )

        await pool.execute(
            """
            UPDATE tg_atmos_messages
            SET processed_at = now()
            WHERE chat_id = $1 AND message_id > $2 AND message_id <= $3
            """,
            chat_id, last_processed, max_message_id,
        )

        negativity_ratio = result.negative_count / result.total_analyzed if result.total_analyzed > 0 else 0.0

        if negativity_ratio >= _cfg.negative_threshold:
            await _send_alert(chat_id, title, username, result, negativity_ratio)

        print(
            f"[atmos] Chat {chat_id} ({title}): "
            f"{result.total_analyzed} msgs, "
            f"{result.negative_count} neg ({negativity_ratio:.0%}), "
            f"risk={result.risk_level}"
        )


async def _send_alert(
    chat_id: int,
    title: str,
    username: str | None,
    result: AnalysisResult,
    ratio: float,
) -> None:
    risk_emoji = {
        "low": "🟡",
        "medium": "🟠",
        "high": "🔴",
        "critical": "🚨",
    }.get(result.risk_level, "⚠️")

    chat_link = build_chat_link(chat_id, username, title)
    reasons_text = ""
    if result.negative_reasons:
        reasons_text = "\n".join(f"  • {r}" for r in result.negative_reasons[:5])
        reasons_text = f"\n<b>Причины:</b>\n{reasons_text}"

    action_text = ""
    if result.recommended_action and result.recommended_action != "none":
        action_text = f"\n<b>Рекомендация:</b> {_escape_html(result.recommended_action)}"

    text = (
        f"{risk_emoji} <b>ВНИМАНИЕ: негатив в чате</b>\n\n"
        f"Чат: {chat_link}\n"
        f"Уровень риска: <b>{result.risk_level}</b>\n"
        f"Атмосфера: {_escape_html(result.summary)}"
        f"{reasons_text}"
        f"{action_text}\n\n"
        f"ℹ️ Здесь учитывается только свежий кусок переписки из последней проверки. "
        f"Общая доля негатива за период показывается в сводке.\n\n"
        f"🕐 {_now_msk()}"
    )

    sent = await send_team_message(text)
    if sent:
        print(f"[atmos] ALERT sent for chat {chat_id} ({title})")
    else:
        print(f"[atmos] ALERT failed for chat {chat_id} ({title})")


# ── Hourly summary (запускается раз в день) ────────────────────────────────

async def run_hourly_summary() -> None:
    pool = await get_pool()

    one_hour_ago = datetime.now(timezone.utc) - timedelta(hours=1)
    two_hours_ago = datetime.now(timezone.utc) - timedelta(hours=2)

    chats = await pool.fetch(
        "SELECT chat_id, chat_title, chat_username FROM tg_atmos_chat_state"
    )

    if not chats:
        print("[atmos] No chats for hourly summary")
        return

    chat_stats: list[dict[str, Any]] = []

    for chat in chats:
        chat_id = chat["chat_id"]

        current = await pool.fetchrow(
            """
            SELECT
                COALESCE(SUM(total_count), 0) AS total_msgs,
                COALESCE(SUM(negative_count), 0) AS total_neg,
                MAX(risk_level) AS max_risk
            FROM tg_atmos_checks
            WHERE chat_id = $1 AND created_at >= $2
            """,
            chat_id, one_hour_ago,
        )

        previous = await pool.fetchrow(
            """
            SELECT
                COALESCE(SUM(total_count), 0) AS total_msgs,
                COALESCE(SUM(negative_count), 0) AS total_neg
            FROM tg_atmos_checks
            WHERE chat_id = $1 AND created_at >= $2 AND created_at < $3
            """,
            chat_id, two_hours_ago, one_hour_ago,
        )

        total_msgs = current["total_msgs"] if current else 0
        total_neg = current["total_neg"] if current else 0
        max_risk = current["max_risk"] if current else "low"
        prev_neg = previous["total_neg"] if previous else 0

        if total_msgs == 0:
            continue

        neg_pct = total_neg / total_msgs if total_msgs > 0 else 0.0

        if prev_neg > 0:
            trend_val = (total_neg - prev_neg) / prev_neg
        elif total_neg > 0:
            trend_val = 1.0
        else:
            trend_val = 0.0

        if trend_val > 0.1:
            trend = "📈"
        elif trend_val < -0.1:
            trend = "📉"
        else:
            trend = "➡️"

        chat_stats.append({
            "chat_id": chat_id,
            "title": chat["chat_title"] or "Unknown",
            "username": chat["chat_username"],
            "total_msgs": total_msgs,
            "total_neg": total_neg,
            "neg_pct": neg_pct,
            "max_risk": max_risk or "low",
            "trend": trend,
        })

    if not chat_stats:
        text = f"📊 <b>Часовая сводка</b>  —  {_now_msk()}\n\nНет активности за последний час."
        await send_team_message(text)
        print("[atmos] Hourly summary: no activity")
        return

    chat_stats.sort(key=lambda c: c["neg_pct"], reverse=True)

    risk_order = {"critical": 4, "high": 3, "medium": 2, "low": 1}

    lines: list[str] = []
    for cs in chat_stats:
        risk_icon = {"low": "🟢", "medium": "🟡", "high": "🟠", "critical": "🔴"}.get(cs["max_risk"], "⚪")
        chat_link = build_chat_link(cs["chat_id"], cs["username"], cs["title"])
        neg_str = f"{cs['neg_pct']:.0%}" if cs["total_neg"] > 0 else "0%"
        lines.append(
            f"  {risk_icon} {chat_link}: "
            f"{cs['total_msgs']} сообщ., негатив {neg_str} {cs['trend']}"
        )

    top_risk = sorted(chat_stats, key=lambda c: risk_order.get(c["max_risk"], 0), reverse=True)[:3]
    top_risk_filtered = [c for c in top_risk if risk_order.get(c["max_risk"], 0) >= 2]

    top_section = ""
    if top_risk_filtered:
        top_lines = []
        for cs in top_risk_filtered:
            chat_link = build_chat_link(cs["chat_id"], cs["username"], cs["title"])
            top_lines.append(f"  ⚠️ {chat_link} — {cs['max_risk']}")
        top_section = "\n\n<b>Требуют внимания:</b>\n" + "\n".join(top_lines)

    total_all = sum(c["total_msgs"] for c in chat_stats)
    neg_all = sum(c["total_neg"] for c in chat_stats)
    overall_pct = f"{neg_all / total_all:.0%}" if total_all > 0 else "0%"

    text = (
        f"📊 <b>Часовая сводка</b>  —  {_now_msk()}\n\n"
        f"Чатов: <b>{len(chat_stats)}</b>  |  "
        f"Сообщений: <b>{total_all}</b>  |  "
        f"Негатив за период: <b>{overall_pct}</b>\n\n"
        f"<b>По чатам:</b>\n"
        + "\n".join(lines)
        + top_section
        + "\n\nℹ️ В сводке процент «Негатив за период» считается по всем сообщениям за окно времени, "
          "а в алерте «ВНИМАНИЕ: негатив в чате» — только по последнему батчу сообщений, "
          "который вызвал срабатывание."
    )

    sent = await send_team_message(text)
    print(f"[atmos] Hourly summary sent: {len(chat_stats)} chats, ok={sent}")


# ── Webhook registration ───────────────────────────────────────────────────

async def register_webhook() -> None:
    webhook_url = os.environ.get("ATMOS_WEBHOOK_URL")
    if not webhook_url:
        print("[atmos] ATMOS_WEBHOOK_URL not set, skipping webhook registration")
        print("[atmos] Set it to register webhook automatically, e.g. https://your-domain.com/webhook")
        return

    result = await tg_api("setWebhook", {
        "url": webhook_url,
        "allowed_updates": ["message", "callback_query"],
        "drop_pending_updates": False,
    })

    if result and result.get("ok"):
        print(f"[atmos] Webhook registered: {webhook_url}")
    else:
        print(f"[atmos] Webhook registration failed: {result}")


# ── Startup message ────────────────────────────────────────────────────────

async def send_startup_message() -> None:
    text = (
        f"✅ <b>Atmos-bot запущен</b>\n\n"
        f"Анализ: каждые {_cfg.check_interval_sec // 60} мин\n"
        f"Сводка: каждые {_cfg.stats_interval_sec // 60} мин\n"
        f"Порог негатива: {_cfg.negative_threshold:.0%}\n"
        f"Модель: <code>{_escape_html(_cfg.model)}</code>\n\n"
        f"🕐 {_now_msk()}"
    )
    await send_team_message(text)


# ── DB schema bootstrap ────────────────────────────────────────────────────

async def ensure_tables() -> None:
    """Create tables if they don't exist (idempotent)."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS tg_atmos_messages (
                chat_id       bigint NOT NULL,
                message_id    bigint NOT NULL,
                sender_id     bigint NOT NULL DEFAULT 0,
                sender_name   text NOT NULL DEFAULT '',
                text          text NOT NULL DEFAULT '',
                chat_title    text NOT NULL DEFAULT '',
                chat_username text,
                sent_at       timestamptz NOT NULL DEFAULT now(),
                created_at    timestamptz NOT NULL DEFAULT now(),
                processed_at  timestamptz,
                PRIMARY KEY (chat_id, message_id)
            );
        """)

        await conn.execute("""
            CREATE TABLE IF NOT EXISTS tg_atmos_checks (
                id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                chat_id            bigint NOT NULL,
                window_from        bigint NOT NULL,
                window_to          bigint NOT NULL,
                total_count        int NOT NULL DEFAULT 0,
                negative_count     int NOT NULL DEFAULT 0,
                sentiment_score    real NOT NULL DEFAULT 0.5,
                risk_level         text NOT NULL DEFAULT 'low',
                reasons            text NOT NULL DEFAULT '[]',
                recommended_action text NOT NULL DEFAULT '',
                summary            text NOT NULL DEFAULT '',
                created_at         timestamptz NOT NULL DEFAULT now()
            );
        """)

        await conn.execute("""
            CREATE INDEX IF NOT EXISTS tg_atmos_checks_chat_created_idx
                ON tg_atmos_checks (chat_id, created_at DESC);
        """)

        await conn.execute("""
            CREATE TABLE IF NOT EXISTS tg_atmos_chat_state (
                chat_id                    bigint PRIMARY KEY,
                chat_title                 text NOT NULL DEFAULT '',
                chat_username              text,
                last_processed_message_id  bigint NOT NULL DEFAULT 0,
                last_hourly_sent_at        timestamptz,
                created_at                 timestamptz NOT NULL DEFAULT now()
            );
        """)

        await conn.execute("""
            CREATE TABLE IF NOT EXISTS tg_atmos_users (
                user_id         bigint PRIMARY KEY,
                username        text,
                full_name       text NOT NULL DEFAULT '',
                created_at      timestamptz NOT NULL DEFAULT now(),
                last_message_at timestamptz
            );
        """)

        await conn.execute("""
            CREATE TABLE IF NOT EXISTS tg_atmos_settings (
                id                   int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
                model                text NOT NULL DEFAULT 'google/gemini-2.0-flash-001',
                check_interval_sec   int NOT NULL DEFAULT 300,
                stats_interval_sec   int NOT NULL DEFAULT 3600,
                negative_threshold   real NOT NULL DEFAULT 0.30,
                system_prompt        text NOT NULL DEFAULT '',
                updated_at           timestamptz NOT NULL DEFAULT now()
            );
        """)

        env_model = os.environ.get("OPENROUTER_ATMOS_MODEL", "google/gemini-2.0-flash-001")
        env_check = int(os.environ.get("ATMOS_CHECK_INTERVAL_SEC", "300"))
        env_stats = int(os.environ.get("ATMOS_STATS_INTERVAL_SEC", "300"))  # 300 = каждые 5 мин (тест), 3600 = раз в час
        env_thresh = float(os.environ.get("ATMOS_NEGATIVE_THRESHOLD", "0.30"))
        await conn.execute(
            """
            INSERT INTO tg_atmos_settings (id, model, check_interval_sec, stats_interval_sec, negative_threshold)
            VALUES (1, $1, $2, $3, $4)
            ON CONFLICT DO NOTHING
            """,
            env_model, env_check, env_stats, env_thresh,
        )
        # При наличии ATMOS_STATS_INTERVAL_SEC в env — применить (для теста: 300 = каждые 5 мин)
        if os.environ.get("ATMOS_STATS_INTERVAL_SEC"):
            await conn.execute(
                "UPDATE tg_atmos_settings SET stats_interval_sec = $1 WHERE id = 1",
                int(os.environ.get("ATMOS_STATS_INTERVAL_SEC", "3600")),
            )

        try:
            await conn.execute("ALTER TABLE tg_atmos_settings ADD COLUMN IF NOT EXISTS system_prompt text NOT NULL DEFAULT ''")
        except Exception:
            pass

    print("[atmos] Tables verified")


# ── Main ────────────────────────────────────────────────────────────────────

async def main() -> None:
    global _scheduler

    _require("DATABASE_URL or SUPABASE_DB_URL", DATABASE_URL)
    _require("TELEGRAM_ATMOS_BOT_TOKEN", TELEGRAM_BOT_TOKEN)
    _require("TELEGRAM_ATMOS_TEAM_CHAT_ID", TEAM_CHAT_ID)
    _require("OPENROUTER_ATMOS_API_KEY", OPENROUTER_API_KEY)

    await ensure_tables()
    await load_config_from_db()

    await register_webhook()
    await send_startup_message()

    app = web.Application()
    app.router.add_post(WEBHOOK_PATH, handle_webhook)
    app.router.add_get("/health", handle_health)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", WEBHOOK_PORT)
    await site.start()
    print(f"[atmos] Webhook server listening on 0.0.0.0:{WEBHOOK_PORT}{WEBHOOK_PATH}")

    _scheduler = AsyncIOScheduler()

    _scheduler.add_job(
        run_analysis_cycle, "interval",
        seconds=_cfg.check_interval_sec,
        id="analysis",
        max_instances=1,
    )

    # Сводка раз в день в 20:00 MSK (17:00 UTC)
    _scheduler.add_job(
        run_hourly_summary,
        CronTrigger(hour=17, minute=0, timezone="UTC"),
        id="daily_summary",
        max_instances=1,
    )

    _scheduler.start()

    print(
        f"[atmos] Started: analysis every {_cfg.check_interval_sec}s, "
        f"daily summary at 20:00 MSK, "
        f"threshold={_cfg.negative_threshold:.0%}, "
        f"model={_cfg.model}"
    )

    while True:
        await asyncio.sleep(3600)


if __name__ == "__main__":
    asyncio.run(main())

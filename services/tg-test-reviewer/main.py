import asyncio
import logging
import re
from datetime import datetime, timedelta, timezone

from telethon import TelegramClient, events, types, utils
from telethon.tl.functions.messages import GetDialogFiltersRequest
from telethon.tl.types import DialogFilter

import config
import db
from doc_fetcher import extract_google_doc_url, fetch_google_doc
from analyzer import analyze_document

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

client = TelegramClient(
    config.SESSION_PATH,
    config.TELEGRAM_API_ID,
    config.TELEGRAM_API_HASH,
)

personal_folder: DialogFilter | None = None
personal_peer_ids: set[int] = set()

CODEWORD_PATTERN = re.compile(
    r"кодовое\s+слово\s*[:\-–—]\s*(.+)", re.IGNORECASE
)

# ── folder helpers ──────────────────────────────────────────────────────────


async def load_personal_folder():
    global personal_folder, personal_peer_ids
    try:
        result = await client(GetDialogFiltersRequest())
        filters = result.filters if hasattr(result, "filters") else result

        for f in filters:
            if not isinstance(f, DialogFilter):
                continue
            title = getattr(f, "title", "")
            if hasattr(title, "text"):
                title = title.text
            if title != config.PERSONAL_FOLDER_NAME:
                continue

            personal_folder = f
            personal_peer_ids = set()
            for p in list(f.include_peers) + list(f.pinned_peers):
                personal_peer_ids.add(utils.get_peer_id(p))
            personal_peer_ids -= {utils.get_peer_id(p) for p in f.exclude_peers}

            logger.info(
                "Loaded folder '%s': %d explicit peers, contacts=%s, non_contacts=%s",
                config.PERSONAL_FOLDER_NAME,
                len(personal_peer_ids),
                f.contacts,
                f.non_contacts,
            )
            return

        logger.warning("Folder '%s' not found — monitoring all private chats", config.PERSONAL_FOLDER_NAME)
    except Exception as e:
        logger.error("Error loading folder: %s — monitoring all private chats", e)


async def is_personal_chat(chat_id: int, sender) -> bool:
    if chat_id in personal_peer_ids:
        return True
    if personal_folder:
        if isinstance(sender, types.User):
            if sender.contact and personal_folder.contacts:
                return True
            if not sender.contact and personal_folder.non_contacts:
                return True
        return False
    return isinstance(sender, types.User) and not sender.bot


# ── keyword matching ────────────────────────────────────────────────────────


def find_keyword(text: str) -> tuple[str, dict] | tuple[None, None]:
    if not text:
        return None, None
    text_lower = text.lower()

    match = CODEWORD_PATTERN.search(text)
    if match:
        word = match.group(1).strip().lower()
        for kw, task in config.KEYWORDS.items():
            if kw in word or word.startswith(kw):
                return kw, task

    for kw, task in config.KEYWORDS.items():
        if kw in text_lower:
            return kw, task

    return None, None


# ── message formatting ──────────────────────────────────────────────────────

EMOJI_NUMS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"]


def format_candidate_message(result: dict, task: dict) -> str:
    lines = ["📋 **Результаты оценки тестового задания**\n"]
    lines.append(f"Позиция: {task['keyword'].title()}\n")

    for i, s in enumerate(result["scores"]):
        em = EMOJI_NUMS[i] if i < len(EMOJI_NUMS) else f"{i + 1}."
        lines.append(f"{em} **{s['criterion']}**: {s['score']}/{s['max_score']}")
        lines.append(f"   → {s['comment']}\n")

    total = result["total_score"]
    lines.append(f"📊 **Итого: {total}/{result['max_total']}**\n")

    if result.get("passed"):
        lines.append(
            "✅ Поздравляем! Ваш результат достаточен для приглашения на собеседование. "
            "Мы свяжемся с вами в ближайшее время!"
        )
    else:
        lines.append(
            f"К сожалению, набранных баллов недостаточно для приглашения "
            f"(порог: {task['pass_threshold']}). Благодарим за участие и желаем успехов!"
        )

    return "\n".join(lines)


def format_report_message(
    result: dict,
    task: dict,
    doc_url: str,
    username: str | None,
    first_name: str | None,
    chat_id: int,
) -> str:
    name = first_name or "Неизвестно"
    user_ref = f"@{username}" if username else f"[{name}](tg://user?id={chat_id})"

    lines = ["📋 **Оценка тестового задания**\n"]
    lines.append(f"👤 Кандидат: {name} ({user_ref})")
    lines.append(f"📝 Позиция: {task['keyword'].title()}")
    lines.append(f"📄 Документ: {doc_url}\n")

    for s in result["scores"]:
        lines.append(f"• {s['criterion']}: **{s['score']}/{s['max_score']}** — {s['comment']}")

    total = result["total_score"]
    lines.append(f"\n📊 **Итого: {total}/{result['max_total']}**")
    lines.append("✅ Пригласить на собеседование" if result.get("passed") else "❌ Баллов недостаточно")

    if result.get("overall_comment"):
        lines.append(f"\n💬 {result['overall_comment']}")

    return "\n".join(lines)


# ── core pipeline ───────────────────────────────────────────────────────────

ACCESS_ERROR_MSG = (
    "⚠️ Не удалось открыть документ. Пожалуйста:\n"
    "1. Откройте документ в Google Docs\n"
    "2. Нажмите «Настройки доступа» (Share)\n"
    "3. Выберите «Все, у кого есть ссылка» → «Читатель»\n"
    "4. Отправьте ссылку сюда ещё раз"
)


async def process_document(event, doc_url: str, keyword: str, task: dict):
    chat_id = event.chat_id
    sender = await event.get_sender()
    username = getattr(sender, "username", None)
    first_name = getattr(sender, "first_name", None)

    if db.is_doc_processed(chat_id, doc_url):
        await event.reply("Этот документ уже был проверен ранее.")
        db.set_state(chat_id, "IDLE")
        return

    await event.reply("📥 Задание получено! Анализирую документ, это займёт пару минут...")

    success, content = await fetch_google_doc(doc_url)
    if not success:
        db.set_state(chat_id, "WAITING_DOC", keyword=keyword, username=username, first_name=first_name)
        if content == "not_found":
            await event.reply("⚠️ Документ не найден. Проверьте ссылку и отправьте ещё раз.")
        elif content == "empty_doc":
            await event.reply("⚠️ Документ пуст. Проверьте, что вы отправили правильную ссылку.")
        elif content == "timeout":
            await event.reply("⚠️ Таймаут при загрузке. Попробуйте отправить ссылку ещё раз.")
        else:
            await event.reply(ACCESS_ERROR_MSG)
        return

    db.set_state(chat_id, "PROCESSING", keyword=keyword, doc_url=doc_url, username=username, first_name=first_name)

    result = await analyze_document(content, task)
    if not result:
        await event.reply("⚠️ Ошибка при анализе документа. Попробуйте отправить ссылку ещё раз.")
        db.set_state(chat_id, "WAITING_DOC", keyword=keyword)
        return

    await event.reply(format_candidate_message(result, task))

    await asyncio.sleep(2)

    try:
        await client.send_message(
            entity=config.REPORT_CHAT_ID,
            message=format_report_message(result, task, doc_url, username, first_name, chat_id),
            reply_to=config.REPORT_TOPIC_ID,
            link_preview=False,
        )
        logger.info("Report sent for %s", username or chat_id)
    except Exception as e:
        logger.error("Failed to send report: %s", e)

    db.save_result(chat_id, doc_url, result["scores"], result["total_score"])
    db.set_state(chat_id, "IDLE")
    logger.info("Done: %s → %d/%d", username or chat_id, result["total_score"], result["max_total"])


# ── event handler ───────────────────────────────────────────────────────────


@client.on(events.NewMessage(incoming=True))
async def on_new_message(event):
    if not event.is_private:
        return
    sender = await event.get_sender()
    if not sender or getattr(sender, "bot", False):
        return
    if not await is_personal_chat(event.chat_id, sender):
        return

    text = event.message.text or ""
    conv = db.get_state(event.chat_id)

    if conv["state"] == "WAITING_DOC":
        doc_url = extract_google_doc_url(text)
        if not doc_url:
            return
        new_kw, new_task = find_keyword(text)
        if new_kw:
            keyword, task = new_kw, new_task
        else:
            keyword = conv["keyword"]
            task = config.KEYWORDS.get(keyword)
        if task:
            await process_document(event, doc_url, keyword, task)
        return

    if conv["state"] == "PROCESSING":
        return

    keyword, task = find_keyword(text)
    if not keyword:
        return

    logger.info("Keyword '%s' from %s", keyword, getattr(sender, "username", None) or event.chat_id)

    doc_url = extract_google_doc_url(text)
    if doc_url:
        await process_document(event, doc_url, keyword, task)
    else:
        db.set_state(
            event.chat_id,
            "WAITING_DOC",
            keyword=keyword,
            username=getattr(sender, "username", None),
            first_name=getattr(sender, "first_name", None),
        )
        await event.reply(
            "✅ Кодовое слово принято! Пожалуйста, отправьте ссылку на Google Документ "
            "с выполненным тестовым заданием."
        )


# ── startup scan ────────────────────────────────────────────────────────────


async def scan_missed_messages():
    logger.info("Scanning for missed messages...")
    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
    count = 0

    async for dialog in client.iter_dialogs(limit=200):
        if not dialog.is_user or getattr(dialog.entity, "bot", False):
            continue
        if not await is_personal_chat(dialog.id, dialog.entity):
            continue

        messages = await client.get_messages(dialog.id, limit=15)
        found_keyword = None
        found_task = None
        found_doc = None

        for msg in reversed(messages):
            if not msg.text or msg.date.replace(tzinfo=timezone.utc) < cutoff:
                continue
            kw, task = find_keyword(msg.text)
            if kw:
                found_keyword = kw
                found_task = task
            doc = extract_google_doc_url(msg.text)
            if doc:
                found_doc = doc

        if not found_keyword or not found_task or not found_doc:
            continue
        if db.is_doc_processed(dialog.id, found_doc):
            continue

        logger.info("Missed submission from %s", getattr(dialog.entity, "username", None) or dialog.id)
        try:
            success, content = await fetch_google_doc(found_doc)
            if not success:
                continue
            result = await analyze_document(content, found_task)
            if not result:
                continue

            username = getattr(dialog.entity, "username", None)
            first_name = getattr(dialog.entity, "first_name", None)

            await client.send_message(dialog.id, format_candidate_message(result, found_task))
            await asyncio.sleep(2)
            await client.send_message(
                entity=config.REPORT_CHAT_ID,
                message=format_report_message(result, found_task, found_doc, username, first_name, dialog.id),
                reply_to=config.REPORT_TOPIC_ID,
                link_preview=False,
            )
            db.save_result(dialog.id, found_doc, result["scores"], result["total_score"])
            db.set_state(dialog.id, "IDLE")
            count += 1
        except Exception as e:
            logger.error("Error processing missed from %s: %s", dialog.id, e)

    logger.info("Missed scan done, processed %d submissions", count)


# ── entrypoint ──────────────────────────────────────────────────────────────


async def main():
    db.init_db()
    db.reset_stuck_states()

    await client.start(phone=config.TELEGRAM_PHONE)
    me = await client.get_me()
    logger.info("Logged in as %s (@%s)", me.first_name, me.username)

    await load_personal_folder()
    await scan_missed_messages()

    logger.info("Listening for new messages...")
    await client.run_until_disconnected()


if __name__ == "__main__":
    client.loop.run_until_complete(main())

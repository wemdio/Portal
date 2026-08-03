"""TG-алерт из portal-external-sync при сбое источника или fatal в main.

Один сбойный источник (metrika / amo_leads / bank_*) роняет только свой
own log-run в external_sync_runs — но остальной pipeline продолжает
крутиться, и без явного алерта сбой обнаруживается только через сутки
через отсутствие свежих данных. Алерт даёт немедленный сигнал.

Дефолтно юзаем существующий health-check бот (он и так шлёт статус
подключений к БД в тот же канал каждые 30 мин — алерты сбоев ложатся
туда же, отдельно ничего настраивать не нужно).

Env, в порядке приоритета:
  WORKER_ALERT_TG_BOT_TOKEN / WORKER_ALERT_TG_ADMIN_IDS — override.
  TELEGRAM_HEALTH_BOT_TOKEN / TELEGRAM_HEALTH_CHAT_ID   — health-check бот.
  TELEGRAM_BOT_TOKEN                                    — общий fallback.
  LEADS_REPORT_TG_BOT_TOKEN / LEADS_REPORT_TG_ADMIN_IDS — последний fallback.

Никогда не бросает: неудачный TG-запрос логируется в stderr и всё.
"""
from __future__ import annotations

import html
import os
import sys
from typing import Mapping, Optional

import httpx

_MAX_LEN = 3800  # TG hard-limit 4096, оставляем запас на форматирование


def _load_creds() -> Optional[tuple[str, list[str]]]:
    token = (
        os.environ.get("WORKER_ALERT_TG_BOT_TOKEN")
        or os.environ.get("TELEGRAM_HEALTH_BOT_TOKEN")
        or os.environ.get("TELEGRAM_BOT_TOKEN")
        or os.environ.get("LEADS_REPORT_TG_BOT_TOKEN")
        or ""
    ).strip()
    raw = (
        os.environ.get("WORKER_ALERT_TG_ADMIN_IDS")
        or os.environ.get("TELEGRAM_HEALTH_CHAT_ID")
        or os.environ.get("LEADS_REPORT_TG_ADMIN_IDS")
        or ""
    )
    chat_ids = [x.strip() for x in raw.split(",") if x.strip()]
    if not token or not chat_ids:
        return None
    return token, chat_ids


async def send_worker_alert(
    worker_id: str,
    subject: str,
    error: BaseException | str,
    context: Optional[Mapping[str, object]] = None,
) -> None:
    creds = _load_creds()
    if not creds:
        print(
            f"[worker-alert] no TG creds ({worker_id}: {subject}) — skip send",
            file=sys.stderr,
            flush=True,
        )
        return

    token, chat_ids = creds
    err_text = str(error) if isinstance(error, BaseException) else str(error)

    lines: list[str] = [
        f"🚨 <b>{html.escape(worker_id)}</b>: {html.escape(subject)}",
        "",
        f"<code>{html.escape(err_text)}</code>",
    ]
    if context:
        lines.append("")
        for k, v in context.items():
            if v is None or v == "":
                continue
            lines.append(
                f"• <i>{html.escape(str(k))}</i>: <code>{html.escape(str(v))}</code>"
            )
    text = "\n".join(lines)[:_MAX_LEN]

    async with httpx.AsyncClient(timeout=10.0) as client:
        for chat_id in chat_ids:
            try:
                r = await client.post(
                    f"https://api.telegram.org/bot{token}/sendMessage",
                    json={
                        "chat_id": chat_id,
                        "text": text,
                        "parse_mode": "HTML",
                        "disable_web_page_preview": True,
                    },
                )
                if r.status_code >= 400:
                    print(
                        f"[worker-alert] TG API rejected ({r.status_code}) "
                        f"for chat={chat_id}: {r.text[:200]}",
                        file=sys.stderr,
                        flush=True,
                    )
            except Exception as e:  # noqa: BLE001 — не хотим ронять источник алерта
                print(
                    f"[worker-alert] TG send failed for chat={chat_id}: {e}",
                    file=sys.stderr,
                    flush=True,
                )

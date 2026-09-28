"""Deterministic VE2 daily report. Source reads are read-only; only the outbox is written.

No LLM, application reconciliation endpoint, collection or contact-provider calls.
An ambiguous Telegram result stops this channel until its receipt is reconciled.
"""
from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime, timedelta, timezone
from html import escape
from pathlib import Path

MSK = timezone(timedelta(hours=3))
UTC = timezone.utc
ROOT = Path(__file__).resolve().parent
SNAPSHOT_SQL = (ROOT / "ve2_snapshot.sql").read_text()
BOOTSTRAP = json.loads((ROOT / "ve2_baseline.json").read_text())
TERMINAL = {"target_reached", "limited", "exhausted"}
LIVE = {"running", "pending"}


def decode(value):
    return json.loads(value) if isinstance(value, str) else value


def moment(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if isinstance(value, str) else value


def count(value):
    return value if type(value) is int and value >= 0 else None


def label(value):
    # One hypothesis must remain one line; never interpret stored names as HTML.
    return escape(re.sub(r"\s+", " ", str(value)).strip()[:180])


def classify(item, now):
    target = item.get("target") or {}
    counted = count(target.get("ready_rows"))
    contacts = count(target.get("ready_contacts"))
    if contacts is None:
        contacts = counted
    goal = count(target.get("ready_target"))
    result = {"key": item["key"], "base_id": item.get("base_id"),
              "project": item["project"], "hypothesis": item["hypothesis"],
              "contacts": contacts, "counted": counted, "goal": goal,
              "state": "issue", "reason": "inconsistent_state"}
    prep = item.get("prep_status")
    jobs = item.get("jobs") or []
    if item.get("prep_error") or item.get("base_error") or prep == "error" or target.get("status") == "error":
        result["reason"] = "preparation_or_collection_error"
        return result
    if item.get("base_id") and (item.get("source") != "auto" or target.get("mode") != "preview"):
        return result
    active = [j for j in jobs if j["status"] in LIVE]
    # A stale status alone is not evidence that work is actually proceeding.
    stale = any(j["status"] == "running" and
                (not j.get("updated_at") or now - moment(j["updated_at"]) > timedelta(hours=2))
                for j in active)
    if stale:
        result["reason"] = "stale_running_job"
        return result
    if active and prep in {"pending", "collecting", "generating"}:
        collecting = [j for j in active if j["stage"] == "base_collect"]
        initial_queue = collecting and all(j["status"] == "pending" and not j.get("started_at") for j in collecting)
        # Pending between rounds is continuation of a collection, not a new queued base.
        initial_queue = initial_queue and (count(target.get("candidates_processed")) or 0) == 0
        result.update(state="queue" if initial_queue else "active",
                      phase="collection" if collecting else "preparation", reason=None)
        return result
    if prep == "pending" and not item.get("base_id") and now - moment(item["prep_updated"]) < timedelta(minutes=10):
        result.update(state="queue", contacts=0, reason=None)
        return result
    failed = any(j["status"] in {"failed", "cancelled"} for j in jobs)
    if (prep == "ready" and item.get("base_status") == "analyzed"
            and item.get("template_status") == "ready" and target.get("status") in TERMINAL
            and not active and not failed and contacts is not None and contacts > 0
            and counted is not None and contacts >= counted and goal is not None and goal > 0):
        result.update(state="ready", below_goal=counted < goal, reason=None)
    return result


async def read_snapshot(conn):
    # A consistent snapshot avoids mixing a pre-completion base with a post-completion job.
    async with conn.transaction(isolation="repeatable_read", readonly=True):
        await conn.execute("SET LOCAL statement_timeout='60s'")
        at = await conn.fetchval("SELECT now()")
        raw = await conn.fetch(SNAPSHOT_SQL)
    items = [classify(decode(row["item"]), at) for row in raw]
    if not items:
        raise ValueError("empty_source_snapshot")
    if len({item["key"] for item in items}) != len(items):
        raise ValueError("duplicate_source_identity")
    return {"at": at.isoformat(), "items": items}


def base_line(item):
    contacts = item.get("contacts")
    amount = f"<b>{contacts:,}</b>".replace(",", " ") if contacts is not None else "число уточняется"
    return f"• <b>{label(item['project'])}</b> · {label(item['hypothesis'])} — {amount}"


def render(snapshot, previous, since):
    old = {i["key"]: i for i in previous["items"]}
    new, grown, active, queue = [], [], [], []
    for item in sorted(snapshot["items"], key=lambda i: (i["project"].casefold(), i["hypothesis"].casefold())):
        before = old.get(item["key"], {})
        if item["state"] == "ready":
            if before.get("state") != "ready" or before.get("base_id") != item["base_id"]:
                new.append(item)
            elif item["contacts"] > (before.get("contacts") or 0):
                grown.append(item)
        elif item["state"] == "active":
            active.append(item)
        elif item["state"] == "queue":
            queue.append(item)
    at = moment(snapshot["at"]).astimezone(MSK)
    start = moment(since).astimezone(MSK)
    lines = ["<b>Сводка по базам</b>",
             f"С прошлого поста: {start:%d.%m %H:%M} — {at:%d.%m %H:%M} МСК.", "",
             f"<b>Завершены базы, письма готовы — {len(new)}:</b>"]
    if not new:
        lines[-1] = "<b>Новых завершённых баз — 0.</b>"
    for item in new:
        suffix = f" (ниже цели {item['goal']})" if item["below_goal"] else ""
        lines.append(base_line(item) + suffix + ".")
    if grown:
        lines += ["", "<b>Увеличился объём готовых баз:</b>"]
        for item in grown:
            delta = item["contacts"] - old[item["key"]]["contacts"]
            lines.append(base_line(item) + f" (+{delta}).")
    lines += ["", f"<b>Собираются или готовятся сейчас — {len(active)}:</b>"]
    for item in active:
        goal = f"; цель {item['goal']}" if item.get("goal") else ""
        phase = "идёт сбор" if item["phase"] == "collection" else "готовятся база и письма"
        lines.append(base_line(item) + f"{goal}, {phase}.")
    lines += ["", f"<b>В очереди — {len(queue)}.</b>"]
    lines += [base_line(item) + "." for item in queue]
    # Keep each HTML line intact. Budget UTF-16 units, conservatively including markup.
    parts, chunk = [], ""
    for line in lines:
        candidate = chunk + ("\n" if chunk else "") + line
        if len(candidate.encode("utf-16-le")) // 2 > 3400:
            parts.append(chunk)
            chunk = "<b>Сводка по базам — продолжение</b>\n" + line
        else:
            chunk = candidate
    if chunk:
        parts.append(chunk)
    return parts


class Rejected(Exception):
    """Telegram explicitly confirmed that sendMessage was rejected."""


class Uncertain(Exception):
    """Delivery may have happened. No blind retry."""


class Telegram:
    def __init__(self, token, chat_id, thread_id):
        self.token, self.chat_id, self.thread_id = token, str(chat_id), str(thread_id or "")

    async def check_recipient(self):
        import httpx
        async with httpx.AsyncClient(timeout=20) as client:
            data = (await client.post(f"https://api.telegram.org/bot{self.token}/getChat",
                                     json={"chat_id": self.chat_id})).json()
        result = data.get("result") or {}
        if not data.get("ok") or str(result.get("id")) != self.chat_id or result.get("title") != BOOTSTRAP["chat_title"]:
            raise ValueError("recipient_mismatch")

    async def send(self, text):
        import httpx
        payload = {"chat_id": self.chat_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}
        if self.thread_id not in ("", "1"):
            payload["message_thread_id"] = int(self.thread_id)
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                response = await client.post(f"https://api.telegram.org/bot{self.token}/sendMessage", json=payload)
                data = response.json()
        except Exception as exc:
            # Exception strings may contain the token URL. Persist only a safe category.
            raise Uncertain(type(exc).__name__) from None
        if data.get("ok") is False and type(data.get("error_code")) is int and 400 <= data["error_code"] < 500:
            raise Rejected(f"telegram_{data['error_code']}")
        result = data.get("result") or {}
        if (data.get("ok") is not True or type(result.get("message_id")) is not int
                or str((result.get("chat") or {}).get("id")) != self.chat_id):
            raise Uncertain("invalid_telegram_receipt")
        return result["message_id"]


class DailyDigest:
    def __init__(self, get_pool, token, chat_id, thread_id="", enabled=True):
        self.get_pool, self.enabled = get_pool, enabled
        self.chat_id = str(chat_id)
        self.thread_id = "" if str(thread_id or "") in ("", "1") else str(thread_id)
        self.channel = f"{self.chat_id}:{self.thread_id}"
        self.telegram = Telegram(token, chat_id, self.thread_id)
        self.health = {"status": "waiting" if enabled else "disabled", "schedule": "11:00 MSK"}
        self._local_lock = asyncio.Lock()

    def check_channel(self):
        if self.chat_id != BOOTSTRAP["chat_id"] or self.thread_id != BOOTSTRAP["thread_id"]:
            raise ValueError("channel_has_no_verified_baseline")

    async def previous(self, conn):
        row = await conn.fetchrow("SELECT snapshot,sent_at FROM public.ve_daily_digests WHERE channel=$1 AND status='sent' ORDER BY sent_at DESC,id DESC LIMIT 1", self.channel)
        if row:
            return decode(row["snapshot"]), row["sent_at"]
        return BOOTSTRAP["snapshot"], moment(BOOTSTRAP["sent_at"])

    async def preview(self, conn):
        """Read-only even before the new migration exists. Does not create an outbox."""
        self.check_channel()
        exists = await conn.fetchval("SELECT to_regclass('public.ve_daily_digests') IS NOT NULL")
        previous, since = await self.previous(conn) if exists else (BOOTSTRAP["snapshot"], moment(BOOTSTRAP["sent_at"]))
        snapshot = await read_snapshot(conn)
        return {"parts": render(snapshot, previous, since), "snapshot": snapshot,
                "private_issues": [i for i in snapshot["items"] if i["state"] == "issue"]}

    async def tick(self):
        if not self.enabled or self._local_lock.locked():
            return
        async with self._local_lock:
            try:
                self.check_channel()
                pool = await self.get_pool()
                if not pool:
                    raise ValueError("database_required")
                async with pool.acquire() as conn:
                    await self._locked_tick(conn)
            except Exception as exc:
                self.health = {"status": "error", "code": type(exc).__name__, "schedule": "11:00 MSK"}
                print(f"[ve2-digest] failed: {type(exc).__name__}", flush=True)

    async def _locked_tick(self, conn):
        # Session lock survives individual autocommits; the pre-send marker must
        # remain durable if the process/DB connection dies after sending.
        locked = await conn.fetchval("SELECT pg_try_advisory_lock(hashtextextended($1,28092026))", self.channel)
        if not locked:
            return
        try:
            await self._tick(conn)
        finally:
            await conn.execute("SELECT pg_advisory_unlock(hashtextextended($1,28092026))", self.channel)

    async def _tick(self, conn):
        now = await conn.fetchval("SELECT clock_timestamp()")
        local = now.astimezone(MSK)
        unresolved = await conn.fetchrow("SELECT * FROM public.ve_daily_digests WHERE channel=$1 AND status<>'sent' ORDER BY id LIMIT 1", self.channel)
        if unresolved and unresolved["status"] in {"sending", "uncertain"}:
            await conn.execute("UPDATE public.ve_daily_digests SET status='uncertain',last_error=coalesce(last_error,'interrupted_send'),updated_at=now() WHERE id=$1", unresolved["id"])
            self.health = {"status": "needs_reconciliation", "report_id": unresolved["id"], "schedule": "11:00 MSK"}
            return
        if local.hour < 11:
            self.health = {"status": "waiting", "schedule": "11:00 MSK"}
            return
        previous, since = await self.previous(conn)
        if since.astimezone(MSK).date() >= local.date() and not unresolved:
            self.health = {"status": "sent", "sent_at": since.isoformat(), "schedule": "11:00 MSK"}
            return
        await self.telegram.check_recipient()
        report = unresolved
        # Before any accepted part, a retry takes fresh data, not yesterday's stale queue.
        if not report or report["next_part"] == 0:
            snapshot = await read_snapshot(conn)
            parts = render(snapshot, previous, since)
            if report:
                report = await conn.fetchrow("UPDATE public.ve_daily_digests SET window_from=$2,snapshot_at=$3,snapshot=$4::jsonb,parts=$5::jsonb,last_error=NULL,updated_at=now() WHERE id=$1 RETURNING *", report["id"], since, moment(snapshot["at"]), json.dumps(snapshot), json.dumps(parts))
            else:
                report = await conn.fetchrow("INSERT INTO public.ve_daily_digests(channel,report_date,window_from,snapshot_at,snapshot,parts) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb) RETURNING *", self.channel, local.date(), since, moment(snapshot["at"]), json.dumps(snapshot), json.dumps(parts))
        parts = decode(report["parts"])
        ids = decode(report["message_ids"])
        for index in range(report["next_part"], len(parts)):
            await conn.execute("UPDATE public.ve_daily_digests SET status='sending',last_error=NULL,updated_at=now() WHERE id=$1", report["id"])
            try:
                message_id = await self.telegram.send(parts[index])
            except Rejected as exc:
                await conn.execute("UPDATE public.ve_daily_digests SET status='pending',last_error=$2,updated_at=now() WHERE id=$1", report["id"], str(exc))
                self.health = {"status": "retry_pending", "report_id": report["id"], "schedule": "11:00 MSK"}
                print(f"[ve2-digest] report {report['id']} rejected: {exc}", flush=True)
                return
            except Uncertain as exc:
                await conn.execute("UPDATE public.ve_daily_digests SET status='uncertain',last_error=$2,updated_at=now() WHERE id=$1", report["id"], str(exc))
                self.health = {"status": "needs_reconciliation", "report_id": report["id"], "schedule": "11:00 MSK"}
                print(f"[ve2-digest] report {report['id']} needs receipt reconciliation: {exc}", flush=True)
                return
            ids.append(message_id)
            final = index + 1 == len(parts)
            # If receipt persistence fails, 'sending' remains and blocks repeats.
            await conn.execute("UPDATE public.ve_daily_digests SET status=$2,next_part=$3,message_ids=$4::jsonb,sent_at=CASE WHEN $2='sent' THEN clock_timestamp() ELSE NULL END,updated_at=now() WHERE id=$1", report["id"], "sent" if final else "pending", index + 1, json.dumps(ids))
        self.health = {"status": "sent", "report_id": report["id"], "schedule": "11:00 MSK"}
        print(f"[ve2-digest] report {report['id']} sent, parts={len(parts)}", flush=True)

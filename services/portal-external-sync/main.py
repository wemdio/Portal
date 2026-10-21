"""
portal-external-sync — external data sync and bank income notifications.

Sources: Yandex Metrika, AMO CRM (сделки, события, задачи, комментарии), Точка
Банк, Т-Банк, Brocard, USDT TRC-20, курсы ЦБ, применение правил разметки
расходов.

Расписание:
- Банки и USDT TRC-20: короткие проверки каждые 15 минут (`BANK_SYNC_CRON`),
  затем новые поступления → ветка оплат через PolzaSiteFeedbackBot.
- Cron `EXTERNAL_SYNC_CRON` (default '5 6,9,12,15,18 * * *' UTC = 9:05, 12:05,
  15:05, 18:05, 21:05 МСК) через APScheduler. С 30.09.2026 пять раз в день, а не
  раз в сутки: правка в AMO или оплата доезжают до дашбордов за часы, а сломанный
  источник поднимает алерт в тот же день. Прогон 18:05 обязателен — на нём
  стоит отчёт продаж в 18:15.
- Catchup на старте контейнера: если текущее время (МСК) уже позже
  STARTUP_WINDOW_START_MSK (default 18:05), но в external_sync_runs нет ни
  одного запуска за сегодня после этой отметки — sync запускается сразу.
  Так деплой в 18:05+ (или в любое время после cron сегодня) сам догоняет
  пропущенный sync до отчёта продаж в 18:15, обычные рестарты до 18:05
  ничего не триггерят. UPSERT-таблицы делают повторный прогон безопасным.

Attribution to projects — отдельная задача, здесь только raw pulls.
Логи по прогонам — таблица external_sync_runs.
"""
from __future__ import annotations

import asyncio
import os
import sys
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    from dotenv import load_dotenv
    _env_path = Path(__file__).resolve().parent.parent.parent / ".env"
    if _env_path.exists():
        load_dotenv(_env_path)
except ImportError:
    pass

import asyncpg
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from alerts import send_worker_alert
from bank_income import (
    IncomeConfig, income_config, prepare_income, dispatch_income,
    recent_bank_periods, LOCK_NAMESPACE,
)
from db import log_run_start, log_run_finish
from sources.metrika import MetrikaSync
from sources.amo import AmoSync
from sources.amo_enrich import AmoCompanyEnrichSync
from sources.amo_events import AmoEventsSync
from sources.amo_tasks import AmoTasksSync
from sources.amo_notes import AmoNotesSync
from sources.bank_tochka import BankTochkaSync
from sources.bank_tbank import BankTBankSync
from sources.brocard import BrocardSync
from sources.crypto_usdt import CryptoUsdtSync
from sources.fx_cbr import FxCbrSync
from sources.expense_rules import ExpenseRulesSync
from sources.meeting_links import MeetingLinksSync
from sources.renewal_marks import RenewalMarksSync

# ── Config ────────────────────────────────────────────────────────────────

CRON = os.environ.get("EXTERNAL_SYNC_CRON", "5 6,9,12,15,18 * * *")  # 9:05…21:05 МСК, каждые 3 ч
BANK_CRON = os.environ.get("BANK_SYNC_CRON", "*/15 * * * *")
DATABASE_URL = os.environ.get("SUPABASE_DB_URL") or os.environ.get("DATABASE_URL", "")

# Отметка (по МСК), после которой рестарт контейнера считает нужным
# «догнать» пропущенный cron сегодняшнего дня. Обычно совпадает с временем
# самого cron (18:05). EXTERNAL_SYNC_STARTUP_WINDOW_END_MSK оставлен только
# ради обратной совместимости имени; catchup работает по проверке БД, а не
# по окну — «был ли уже сегодня запуск после STARTUP_MSK».
STARTUP_WINDOW_START_MSK = os.environ.get("EXTERNAL_SYNC_STARTUP_WINDOW_START_MSK", "18:05")
STARTUP_WINDOW_END_MSK   = os.environ.get("EXTERNAL_SYNC_STARTUP_WINDOW_END_MSK", "18:15")  # unused, kept for env compatibility
MSK_TZ = timezone(timedelta(hours=3))

SOURCES = [
    MetrikaSync(),
    AmoSync(),
    AmoEventsSync(),         # после AmoSync: нужны свежие amo_statuses
    AmoTasksSync(),          # результаты выполненных задач (result.text) — сигнал продлений,
                             # см. docs/superpowers/plans/2026-08-03-renewals-from-payments.md;
                             # порядок относительно AmoEventsSync не важен (свой watermark, своя
                             # таблица), поставлено сразу после по просьбе плана Task 1
    AmoNotesSync(),          # комментарии AMO (note_type=common) — приоритетный сигнал продлений
                             # начиная с 2026-08-03 («Продление N - сумма»), см.
                             # supabase/migrations/20260803_0003_amo_notes.sql и
                             # sources/renewal_marks.py / apply_renewal_marks(); сразу после
                             # AmoTasksSync по тому же принципу (свой watermark, своя таблица,
                             # порядок между ними не важен)
    AmoCompanyEnrichSync(),  # ходит на company_website и заполняет company_name; идёт СТРОГО после AmoSync
    MeetingLinksSync(),      # СТРОГО сразу после AmoCompanyEnrichSync(): матчинг по названию
                             # компании опирается на company_name, который заполняет именно она —
                             # ниже по списку у сделок этой ночи название будет пустым (см.
                             # sources/meeting_links.py)
    BankTochkaSync(),
    BankTBankSync(),
    BrocardSync(),
    CryptoUsdtSync(),   # СТРОГО до FxCbrSync: курс доллара за даты крипто-приходов
                        # собирается в тот же прогон, что и сами приходы (fx_cbr
                        # спрашивает ЦБ только за даты, где уже есть операции)
    FxCbrSync(),        # после Brocard: спрашивает курсы под уже приехавшие валютные траты
    RenewalMarksSync(), # после AmoNotesSync, AmoTasksSync И после банков (BankTochkaSync/
                        # BankTBankSync выше): нужны свежие комментарии (приоритетный сигнал,
                        # см. 20260803_0004_renewal_marks_note_text.sql), свежие задачи
                        # (result_text) и свежие платежи, см.
                        # docs/superpowers/plans/2026-08-03-renewals-from-payments.md (Task 2)
                        # и sources/renewal_marks.py
    ExpenseRulesSync(), # строго последним: размечает всё, что приехало выше
]

# ── Run pipeline ──────────────────────────────────────────────────────────

async def run_source(conn: asyncpg.Connection, src, mode: str = "full") -> None:
    # Both schedules share a lock per source, also across worker replicas.
    lock_id = {"bank_tochka": 1, "bank_tbank": 2, "crypto_usdt": 4, "fx_cbr": 5}.get(src.name)
    if lock_id is not None:
        locked = await conn.fetchval("SELECT pg_try_advisory_lock($1, $2)", LOCK_NAMESPACE, lock_id)
        if not locked:
            print(f"[{src.name}] {mode}: another sync of this source is running", flush=True)
            return
    try:
        run_id = await log_run_start(conn, src.name)
        try:
            if mode == "recent":
                timeout = 90 if src.name == "fx_cbr" else getattr(src, "recent_timeout_sec", 240)
                n = await asyncio.wait_for(src.run(conn), timeout=timeout)
            else:
                n = await src.run(conn)
            await log_run_finish(conn, run_id, "success", records=n, meta={"mode": mode})
            print(f"[{src.name}] {mode}: ok — upserted {n}", flush=True)
        except NotImplementedError as e:
            await log_run_finish(conn, run_id, "partial", error=str(e), meta={"mode": mode})
            print(f"[{src.name}] skipped — {e}", flush=True)
        except Exception as e:
            tb = traceback.format_exc()
            await log_run_finish(conn, run_id, "error", error=str(e), meta={"mode": mode})
            print(f"[{src.name}] FAIL — {e}\n{tb}", flush=True)
            await send_worker_alert(
                worker_id="portal-external-sync", subject=f"{src.name} failed",
                error=e, context={"source": src.name, "mode": mode},
            )
    finally:
        if lock_id is not None:
            await conn.execute("SELECT pg_advisory_unlock($1, $2)", LOCK_NAMESPACE, lock_id)


async def prepare_bank_income(conn: asyncpg.Connection) -> IncomeConfig | None:
    try:
        config = income_config()
        if config:
            await prepare_income(conn, config)
        return config
    except Exception as e:
        await send_worker_alert("bank-income", "уведомления не подготовлены", type(e).__name__)
        print(f"[bank-income] prepare failed ({type(e).__name__})", flush=True)
        return None


async def run_banks() -> None:
    if not DATABASE_URL:
        print("[banks] DATABASE_URL not set", flush=True)
        return
    conn = await asyncpg.connect(DATABASE_URL)
    try:
        config = await prepare_bank_income(conn)
        periods = recent_bank_periods(datetime.now(timezone.utc))
        since = datetime.fromisoformat(periods[0][0]).replace(tzinfo=MSK_TZ)
        # Independent APIs use independent DB sessions. A slow bank must not
        # delay crypto or the next fifteen-minute tick of the other bank.
        sources = (BankTochkaSync(periods), BankTBankSync(periods), CryptoUsdtSync(since))
        await asyncio.gather(*(_run_recent_source(src) for src in sources))
        # Portal's RUB income totals need the rate for newly arrived USDT dates.
        await run_source(conn, FxCbrSync(), mode="recent")
        if config:
            try:
                await dispatch_income(conn, config)
            except Exception as e:
                # Never forward httpx request URLs (they contain the bot token).
                await send_worker_alert("bank-income", "сбой обработки уведомлений", type(e).__name__)
                print(f"[bank-income] dispatch failed ({type(e).__name__})", flush=True)
    finally:
        await conn.close()


async def _run_recent_source(src) -> None:
    conn = None
    try:
        conn = await asyncpg.connect(DATABASE_URL)
        await run_source(conn, src, mode="recent")
    except Exception as e:
        await send_worker_alert("portal-external-sync", f"{src.name}: recent sync failed", type(e).__name__)
    finally:
        if conn is not None:
            await conn.close()


async def run_all() -> None:
    if not DATABASE_URL:
        print("[main] FATAL: SUPABASE_DB_URL / DATABASE_URL not set", flush=True)
        return

    print("[main] connecting to db…", flush=True)
    conn = await asyncpg.connect(DATABASE_URL)
    try:
        for src in SOURCES:
            await run_source(conn, src)
    finally:
        await conn.close()
        print("[main] cycle finished", flush=True)


# ── Startup catchup check ─────────────────────────────────────────────────

def _parse_msk_time(value: str) -> tuple[int, int]:
    """Парсит `H` / `HH` / `HH:MM` в пару (hour, minute)."""
    parts = value.strip().split(":", 1)
    hour = int(parts[0])
    minute = int(parts[1]) if len(parts) == 2 else 0
    if not 0 <= hour <= 23 or not 0 <= minute <= 59:
        raise ValueError(f"invalid MSK time: {value!r}")
    return hour, minute


async def _should_catchup_on_startup() -> bool:
    """Правило catchup: если сейчас (по МСК) уже позже STARTUP_MSK и в
    external_sync_runs за сегодня после этой отметки нет ни одного запуска —
    возвращаем True (нужно догнать пропущенный cron сразу на старте).

    После 18:05 пропущенный полный sync догоняется сразу; короткие банковские
    проверки не считаются запуском полного pipeline перед отчётом в 18:15.
    """
    now_msk = datetime.now(MSK_TZ)
    start_hour, start_minute = _parse_msk_time(STARTUP_WINDOW_START_MSK)
    scheduled_today_msk = now_msk.replace(
        hour=start_hour, minute=start_minute, second=0, microsecond=0,
    )
    stamp = now_msk.strftime("%H:%M МСК")

    if now_msk < scheduled_today_msk:
        print(
            f"[main] catchup: {stamp} — до расписанного sync "
            f"{STARTUP_WINDOW_START_MSK} МСК → жду cron",
            flush=True,
        )
        return False

    if not DATABASE_URL:
        print("[main] catchup: DATABASE_URL пуст — проверка БД пропущена", flush=True)
        return False

    conn = await asyncpg.connect(DATABASE_URL)
    try:
        scheduled_today_utc = scheduled_today_msk.astimezone(timezone.utc)
        row = await conn.fetchrow(
            "SELECT MAX(started_at) AS last_run "
            "FROM external_sync_runs "
            "WHERE started_at >= $1 AND (meta->>'mode') IS DISTINCT FROM 'recent'",
            scheduled_today_utc,
        )
    finally:
        await conn.close()

    last_run = row["last_run"] if row else None
    if last_run is not None:
        last_msk = last_run.astimezone(MSK_TZ).strftime("%H:%M МСК")
        print(
            f"[main] catchup: {stamp} — sync за сегодня уже был в {last_msk} "
            f"→ жду следующего cron",
            flush=True,
        )
        return False

    print(
        f"[main] catchup: {stamp} после {STARTUP_WINDOW_START_MSK} МСК, "
        f"а sync за сегодня ещё не было → догоняю сразу",
        flush=True,
    )
    return True


# ── Entry ─────────────────────────────────────────────────────────────────

async def main() -> None:
    print(f"portal-external-sync starting; cron='{CRON}', bank_cron='{BANK_CRON}'", flush=True)

    # Establish the baseline before either schedule can insert bank rows. Only
    # bot verification runs here: a slow bank must not delay the sales catchup.
    if DATABASE_URL:
        conn = await asyncpg.connect(DATABASE_URL)
        try:
            await prepare_bank_income(conn)
        finally:
            await conn.close()
    catchup = await _should_catchup_on_startup()

    scheduler = AsyncIOScheduler(timezone="UTC")
    scheduler.add_job(
        run_all,
        CronTrigger.from_crontab(CRON, timezone="UTC"),
        id="external_sync",
        max_instances=1,
        coalesce=True,
    )
    scheduler.add_job(
        run_banks,
        CronTrigger.from_crontab(BANK_CRON, timezone="UTC"),
        id="bank_sync", max_instances=1, coalesce=True,
        next_run_time=datetime.now(timezone.utc),
    )
    scheduler.start()

    if catchup:
        await run_all()

    # Держим event loop живым; APScheduler крутится в фоне.
    while True:
        await asyncio.sleep(3600)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, SystemExit):
        print("[main] shutdown", flush=True)
        sys.exit(0)
    except Exception as fatal:
        tb = traceback.format_exc()
        print(f"[main] FATAL — {fatal}\n{tb}", flush=True)
        try:
            asyncio.run(send_worker_alert(
                worker_id="portal-external-sync",
                subject="fatal (main crashed)",
                error=fatal,
            ))
        except Exception as alert_err:  # noqa: BLE001
            print(f"[main] alert send failed: {alert_err}", flush=True)
        sys.exit(1)

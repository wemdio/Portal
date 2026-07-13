"""
portal-external-sync — nightly sync of external data into main-postgres.

Sources: Yandex Metrika, AMO CRM, Точка Банк, Т-Банк.

Расписание:
- Cron `EXTERNAL_SYNC_CRON` (default '0 2 * * *' UTC = 5:00 МСК) через APScheduler.
- На старте контейнера: если время старта попадает в окно
  [STARTUP_WINDOW_START_MSK, STARTUP_WINDOW_END_MSK) МСК (default 3-9),
  запускается синк сразу. Цель — при деплое в 3-5 МСК контейнер сам догонит
  пропущенный ночной cron, но обычные рестарты в течение дня НЕ триггерят
  ненужный синк. UPSERT-таблицы делают любой повторный прогон безопасным.

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

from db import log_run_start, log_run_finish
from sources.metrika import MetrikaSync
from sources.amo import AmoSync
from sources.amo_enrich import AmoCompanyEnrichSync
from sources.bank_tochka import BankTochkaSync
from sources.bank_tbank import BankTBankSync

# ── Config ────────────────────────────────────────────────────────────────

CRON = os.environ.get("EXTERNAL_SYNC_CRON", "0 2 * * *")  # 5:00 МСК
DATABASE_URL = os.environ.get("SUPABASE_DB_URL") or os.environ.get("DATABASE_URL", "")

# Окно (по МСК), внутри которого рестарт контейнера триггерит синк сразу.
STARTUP_WINDOW_START_MSK = int(os.environ.get("EXTERNAL_SYNC_STARTUP_WINDOW_START_MSK", "3"))
STARTUP_WINDOW_END_MSK   = int(os.environ.get("EXTERNAL_SYNC_STARTUP_WINDOW_END_MSK", "9"))
MSK_TZ = timezone(timedelta(hours=3))

SOURCES = [
    MetrikaSync(),
    AmoSync(),
    AmoCompanyEnrichSync(),  # ходит на company_website и заполняет company_name; идёт СТРОГО после AmoSync
    BankTochkaSync(),
    BankTBankSync(),
]

# ── Run pipeline ──────────────────────────────────────────────────────────

async def run_all() -> None:
    if not DATABASE_URL:
        print("[main] FATAL: SUPABASE_DB_URL / DATABASE_URL not set", flush=True)
        return

    print("[main] connecting to db…", flush=True)
    conn = await asyncpg.connect(DATABASE_URL)
    try:
        for src in SOURCES:
            run_id = await log_run_start(conn, src.name)
            try:
                n = await src.run(conn)
                await log_run_finish(conn, run_id, "success", records=n)
                print(f"[{src.name}] ok — upserted {n}", flush=True)
            except NotImplementedError as e:
                # Source не готов — не ошибка, а «пока пропускаем».
                await log_run_finish(conn, run_id, "partial", error=str(e))
                print(f"[{src.name}] skipped — {e}", flush=True)
            except Exception as e:
                tb = traceback.format_exc()
                await log_run_finish(conn, run_id, "error", error=str(e))
                print(f"[{src.name}] FAIL — {e}\n{tb}", flush=True)
    finally:
        await conn.close()
        print("[main] cycle finished", flush=True)


# ── Startup window check ──────────────────────────────────────────────────

def _in_startup_window() -> tuple[bool, str]:
    """Проверяет, попадает ли текущий момент по МСК в окно deploy-догона.

    Возвращает (should_run, human_reason).
    """
    now_msk = datetime.now(MSK_TZ)
    hour = now_msk.hour
    in_window = STARTUP_WINDOW_START_MSK <= hour < STARTUP_WINDOW_END_MSK
    stamp = now_msk.strftime("%H:%M МСК")
    window = f"{STARTUP_WINDOW_START_MSK:02d}:00-{STARTUP_WINDOW_END_MSK:02d}:00 МСК"
    if in_window:
        return True, f"старт в {stamp} — внутри deploy-окна {window} → синк сразу"
    return False, f"старт в {stamp} — вне deploy-окна {window} → жду cron"


# ── Entry ─────────────────────────────────────────────────────────────────

async def main() -> None:
    should_run, reason = _in_startup_window()
    print(f"portal-external-sync starting; cron='{CRON}'", flush=True)
    print(f"[main] {reason}", flush=True)

    scheduler = AsyncIOScheduler(timezone="UTC")
    scheduler.add_job(
        run_all,
        CronTrigger.from_crontab(CRON, timezone="UTC"),
        id="external_sync",
        max_instances=1,
        coalesce=True,
    )
    scheduler.start()

    if should_run:
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

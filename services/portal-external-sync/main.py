"""
portal-external-sync — nightly sync of external data into main-postgres.

Sources: Yandex Metrika, AMO CRM, Точка Банк, Т-Банк.
Schedule: EXTERNAL_SYNC_CRON (default '0 3 * * *' UTC), APScheduler cron trigger.
Attribution to projects лежит отдельно — здесь только raw pulls.

Manual run: EXTERNAL_SYNC_RUN_ON_STARTUP=true (полезно при первом деплое / бэкфилле).
Логи по прогонам — таблица external_sync_runs (см. миграцию 20260706_0001).
"""
from __future__ import annotations

import asyncio
import os
import sys
import traceback
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
from sources.bank_tochka import BankTochkaSync
from sources.bank_tbank import BankTBankSync

# ── Config ────────────────────────────────────────────────────────────────

CRON = os.environ.get("EXTERNAL_SYNC_CRON", "0 3 * * *")
DATABASE_URL = os.environ.get("SUPABASE_DB_URL") or os.environ.get("DATABASE_URL", "")
RUN_ON_STARTUP = os.environ.get("EXTERNAL_SYNC_RUN_ON_STARTUP", "false").lower() == "true"

SOURCES = [
    MetrikaSync(),
    AmoSync(),
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


# ── Entry ─────────────────────────────────────────────────────────────────

async def main() -> None:
    print(f"portal-external-sync starting; cron='{CRON}', run_on_startup={RUN_ON_STARTUP}", flush=True)

    scheduler = AsyncIOScheduler(timezone="UTC")
    scheduler.add_job(
        run_all,
        CronTrigger.from_crontab(CRON, timezone="UTC"),
        id="external_sync",
        max_instances=1,
        coalesce=True,
    )
    scheduler.start()

    if RUN_ON_STARTUP:
        print("[main] EXTERNAL_SYNC_RUN_ON_STARTUP=true → immediate run", flush=True)
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

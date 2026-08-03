"""
portal-external-sync — daily sync of external data into main-postgres.

Sources: Yandex Metrika, AMO CRM (сделки, события, задачи), Точка Банк,
Т-Банк, Brocard, USDT TRC-20, курсы ЦБ, применение правил разметки расходов.

Расписание:
- Cron `EXTERNAL_SYNC_CRON` (default '30 13 * * *' UTC = 16:30 МСК) через APScheduler.
- Catchup на старте контейнера: если текущее время (МСК) уже позже
  STARTUP_WINDOW_START_MSK (default 16:30), но в external_sync_runs нет ни
  одного запуска за сегодня после этой отметки — sync запускается сразу.
  Так деплой в 16:30+ (или в любое время после cron сегодня) сам догоняет
  пропущенный sync до отчёта продаж в 17:00, обычные рестарты до 16:30
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
from db import log_run_start, log_run_finish
from sources.metrika import MetrikaSync
from sources.amo import AmoSync
from sources.amo_enrich import AmoCompanyEnrichSync
from sources.amo_events import AmoEventsSync
from sources.amo_tasks import AmoTasksSync
from sources.bank_tochka import BankTochkaSync
from sources.bank_tbank import BankTBankSync
from sources.brocard import BrocardSync
from sources.crypto_usdt import CryptoUsdtSync
from sources.fx_cbr import FxCbrSync
from sources.expense_rules import ExpenseRulesSync
from sources.meeting_links import MeetingLinksSync
from sources.renewal_marks import RenewalMarksSync

# ── Config ────────────────────────────────────────────────────────────────

CRON = os.environ.get("EXTERNAL_SYNC_CRON", "30 13 * * *")  # 16:30 МСК
DATABASE_URL = os.environ.get("SUPABASE_DB_URL") or os.environ.get("DATABASE_URL", "")

# Отметка (по МСК), после которой рестарт контейнера считает нужным
# «догнать» пропущенный cron сегодняшнего дня. Обычно совпадает с временем
# самого cron (16:30). EXTERNAL_SYNC_STARTUP_WINDOW_END_MSK оставлен только
# ради обратной совместимости имени; catchup работает по проверке БД, а не
# по окну — «был ли уже сегодня запуск после STARTUP_MSK».
STARTUP_WINDOW_START_MSK = os.environ.get("EXTERNAL_SYNC_STARTUP_WINDOW_START_MSK", "16:30")
STARTUP_WINDOW_END_MSK   = os.environ.get("EXTERNAL_SYNC_STARTUP_WINDOW_END_MSK", "17:00")  # unused, kept for env compatibility
MSK_TZ = timezone(timedelta(hours=3))

SOURCES = [
    MetrikaSync(),
    AmoSync(),
    AmoEventsSync(),         # после AmoSync: нужны свежие amo_statuses
    AmoTasksSync(),          # результаты выполненных задач (result.text) — сигнал продлений,
                             # см. docs/superpowers/plans/2026-08-03-renewals-from-payments.md;
                             # порядок относительно AmoEventsSync не важен (свой watermark, своя
                             # таблица), поставлено сразу после по просьбе плана Task 1
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
    RenewalMarksSync(), # после AmoTasksSync И после банков (BankTochkaSync/BankTBankSync выше):
                        # нужны и свежие задачи (result_text), и свежие платежи, см.
                        # docs/superpowers/plans/2026-08-03-renewals-from-payments.md (Task 2)
                        # и sources/renewal_marks.py
    ExpenseRulesSync(), # строго последним: размечает всё, что приехало выше
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
                await send_worker_alert(
                    worker_id="portal-external-sync",
                    subject=f"{src.name} failed",
                    error=e,
                    context={"source": src.name},
                )
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

    Так деплой/рестарт в любое время после 16:45 автоматически даст свежий
    sync до отчёта продаж в 17:10; обычные рестарты до 16:45 ничего не делают.
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
            "WHERE started_at >= $1",
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
    print(f"portal-external-sync starting; cron='{CRON}'", flush=True)

    scheduler = AsyncIOScheduler(timezone="UTC")
    scheduler.add_job(
        run_all,
        CronTrigger.from_crontab(CRON, timezone="UTC"),
        id="external_sync",
        max_instances=1,
        coalesce=True,
    )
    scheduler.start()

    if await _should_catchup_on_startup():
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

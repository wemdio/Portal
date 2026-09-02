/**
 * HH worker — четыре очереди в одном контейнере: обычный HH-парсер и ATS
 * (обе через `parser_jobs`), архив вакансий (`hh_archive_jobs`) и
 * Яндекс.Директ (`yandex_direct_jobs`).
 *
 * 02.09.2026: архив и Директ переведены на единый жизненный цикл задач
 * (lib/jobs/lifecycle.ts) — захват по аренде, продление таймером, чекпойнт по
 * пройденным чанкам/запросам, освобождение аренды при остановке. Восстановление
 * их `processing` при старте снято: брошенную задачу определяет истёкшая
 * аренда, а не возраст `updated_at`, и потому механизм корректен при любом
 * числе реплик. Вместе с ним снят и глобальный мьютекс в памяти на каждую из
 * двух очередей — его роль играет `concurrency: 1` у соответствующего раннера.
 *
 * `parser_jobs` (HH и ATS) ОСТАЮТСЯ на прежнем механизме: их перевод — задача 5
 * этапа 2. Поэтому здесь по-прежнему живут recoverRunningParserJobs, мьютекс
 * atsJobActive и набор `running`, а сам сервис worker-hh не добавлен в
 * is_lifecycle_managed_worker в drain-worker.sh.
 */

import { runHHParserJob } from '@/lib/parsers/hhRunner';
import {
  runHHArchiveJob,
  type HHArchiveCheckpoint,
} from '@/lib/parsers/hhArchive/runner';
import {
  runYandexDirectJob,
  type YandexDirectCheckpoint,
} from '@/lib/parsers/yandexDirect/runner';
import { runAtsParserJob } from '@/lib/parsers/atsRunner';
import { createJobRunner } from '@/lib/jobs/lifecycle';
import { markShuttingDown } from '@/lib/workerShutdown';
import { createWorkerLogger, pollLoop, requireSupabaseAdmin, setupGracefulShutdown, sleep } from './_shared';
import { claimParserJob, recoverRunningParserJobs } from './parserJobs';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '5000');
const MAX_CONCURRENCY = 3;
const DRAIN_TIMEOUT_MS = Number(process.env.WORKER_DRAIN_TIMEOUT_MINUTES ?? '180') * 60 * 1000;
const WORKER_ID = `hh-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);
const running = new Set<Promise<void>>();
// ATS-парсер (Greenhouse/Lever/Ashby) — глобально один за раз: ходит по тысячам
// внешних бордов + Clearbit, держим concurrency=1, чтобы не словить rate-limit.
// Остаётся мьютексом в памяти, пока parser_jobs не переехали на жизненный цикл.
let atsJobActive = false;

/**
 * Аренда — признак живости ПРОЦЕССА. Продление идёт независимым таймером каждые
 * аренда/3 = 60 с, поэтому срок держим коротким: после краха/OOM/SIGKILL строку
 * подберут через аренду (3 мин) + один опрос (30 с: realtime будит только на
 * status=eq.pending) ≈ 3,5 минуты.
 */
const ARCHIVE_LEASE_SECONDS = Math.max(60, Number(process.env.HH_ARCHIVE_LEASE_SECONDS ?? '180'));
const YANDEX_DIRECT_LEASE_SECONDS = Math.max(60, Number(process.env.YANDEX_DIRECT_LEASE_SECONDS ?? '180'));

/**
 * Порог остановки прогресса — признак живости РАБОТЫ, отдельный от аренды.
 *
 * Архив: колонка processed_chunks, она двигается после каждого поискового
 * запроса. Самый длинный ЗАКОННЫЙ промежуток между её записями — один чанк:
 * fetchVacanciesLocal листает hh_vacancies батчами по 1000 строк, при
 * max_results=50000 это ~55 батчей, каждый ILIKE-запрос по большой таблице до
 * нескольких секунд — итого до ~5 минут на чанк. Берём порог 10 минут: вдвое
 * выше законного максимума и укладывается в бюджет монитора —
 * 10 мин + не больше одной аренды (3 мин) + не больше одного опроса (30 с)
 * = 13,5 мин < HEALTH_JOB_STUCK_MIN (20 мин). Меняя слагаемое, сверяй сумму.
 *
 * НЕ updated_at: на этой таблице висит безусловный триггер
 * trg_hh_archive_jobs_updated_at (миграция 20260516_0001), а продление аренды —
 * это UPDATE строки. По updated_at «прогресс» был бы всегда, простоя не было бы
 * никогда, и заодно на каждом тике обнулялся бы бюджет попыток.
 */
const ARCHIVE_STALL_MS = Math.max(60_000, Number(process.env.HH_ARCHIVE_STALL_MINUTES ?? '10') * 60_000);
/**
 * Директ: колонка processed_requests, пишется каждые 10 запросов к XMLStock.
 * Законный максимум складывается из генерации ключей в AI-режиме (LLM + до 60
 * вызовов Yandex Suggest по 300 мс ≈ 2–3 мин, она идёт ДО первой записи
 * прогресса) и десяти запросов с паузой 600 мс (≈ 2 мин) — до ~5 минут.
 * Порог 10 минут, сумма та же: 10 + 3 + 0,5 = 13,5 мин < 20 мин.
 * updated_at не годится по той же причине, что у архива (триггер
 * trg_yandex_direct_jobs_updated_at, миграция 20260517_0001).
 */
const YANDEX_DIRECT_STALL_MS = Math.max(60_000, Number(process.env.YANDEX_DIRECT_STALL_MINUTES ?? '10') * 60_000);

async function startupRecovery(): Promise<void> {
  // Только parser_jobs: у hh_archive_jobs и yandex_direct_jobs восстановление
  // снято вместе с переездом на жизненный цикл — брошенную задачу там
  // определяет истёкшая аренда, а сброс по возрасту updated_at отбирал бы
  // строку у живого исполнителя.
  await recoverRunningParserJobs(log, ['hh_vacancies', 'ats_companies'], 'HH/ATS parser_jobs');
}

async function claimHHJob(): Promise<string | null> {
  return claimParserJob(log, 'hh_vacancies');
}

/**
 * Атомарно клеймит один pending ATS parser_jobs (parser_type='ats_companies').
 * Глобальная concurrency=1 (atsJobActive): много внешних запросов + Clearbit.
 */
async function claimAtsJob(): Promise<string | null> {
  if (atsJobActive) return null;
  return claimParserJob(log, 'ats_companies');
}

async function main(): Promise<void> {
  log('info', `Starting HH worker (pid=${process.pid})`);
  requireSupabaseAdmin(log);
  const shouldStop = setupGracefulShutdown(log);

  log('info', 'Running startup recovery...');
  await startupRecovery();
  log('info', 'Startup recovery done');

  /**
   * Архив вакансий. Статусы — из check-констрейнта таблицы (миграция
   * 20260516_0001): выполнение здесь называется processing, а не running.
   * concurrency=1 — rate-limit HH общий на IP; раньше это же обеспечивал
   * мьютекс archiveJobActive.
   */
  const archiveRunner = createJobRunner<{ id: string }, HHArchiveCheckpoint>({
    table: 'hh_archive_jobs',
    workerId: WORKER_ID,
    statuses: { pending: 'pending', running: 'processing', done: 'completed', failed: 'failed' },
    leaseSeconds: ARCHIVE_LEASE_SECONDS,
    concurrency: 1,
    // Терминальный статус пишет сам раннер задачи: он умеет отличить отмену
    // пользователем от ошибки и кладёт человеку текст в error_message.
    manageTerminalStatus: false,
    progress: { column: 'processed_chunks', stalledAfterMs: ARCHIVE_STALL_MS },
    claimPatch: () => ({ started_at: new Date().toISOString() }),
    failedPatch: (reason) => ({ error_message: reason, completed_at: new Date().toISOString() }),
    shutdownGraceMs: 5_000,
    log,
    run: async (job, ctx) => {
      log('info', `Running HH archive job ${job.id}${ctx.checkpoint ? ' (RESUME)' : ''}`);
      const db = requireSupabaseAdmin(log);
      await runHHArchiveJob(db, job.id, {
        signal: ctx.signal,
        runToken: ctx.runToken,
        checkpoint: ctx.checkpoint,
        saveCheckpoint: ctx.saveCheckpoint,
      });
    },
  });

  /**
   * Яндекс.Директ. Те же статусы (миграция 20260517_0001), concurrency=1 —
   * XMLStock лимитирует по аккаунту; раньше это обеспечивал мьютекс
   * yandexDirectJobActive.
   */
  const directRunner = createJobRunner<{ id: string }, YandexDirectCheckpoint>({
    table: 'yandex_direct_jobs',
    workerId: WORKER_ID,
    statuses: { pending: 'pending', running: 'processing', done: 'completed', failed: 'failed' },
    leaseSeconds: YANDEX_DIRECT_LEASE_SECONDS,
    concurrency: 1,
    manageTerminalStatus: false,
    progress: { column: 'processed_requests', stalledAfterMs: YANDEX_DIRECT_STALL_MS },
    claimPatch: () => ({ started_at: new Date().toISOString() }),
    failedPatch: (reason) => ({ error_message: reason, completed_at: new Date().toISOString() }),
    shutdownGraceMs: 5_000,
    log,
    run: async (job, ctx) => {
      log('info', `Running Yandex Direct job ${job.id}${ctx.checkpoint ? ' (RESUME)' : ''}`);
      const db = requireSupabaseAdmin(log);
      await runYandexDirectJob(db, job.id, {
        signal: ctx.signal,
        runToken: ctx.runToken,
        checkpoint: ctx.checkpoint,
        saveCheckpoint: ctx.saveCheckpoint,
      });
    },
  });

  const pollOnce = async (): Promise<boolean> => {
    // Сначала пробуем обычный HH-парсер (concurrency=3, обычно есть свободный слот).
    if (running.size < MAX_CONCURRENCY) {
      const jobId = await claimHHJob();
      if (jobId) {
        const task = (async () => {
          log('info', `Running HH parser job ${jobId}`);
          await runHHParserJob(jobId, DRAIN_TIMEOUT_MS);
        })();
        running.add(task);
        void task.finally(() => running.delete(task));
        return true;
      }
    }

    // ATS-парсер (Greenhouse/Lever/Ashby) — глобально один на воркер.
    if (!atsJobActive) {
      const atsJobId = await claimAtsJob();
      if (atsJobId) {
        atsJobActive = true;
        const task = (async () => {
          log('info', `Running ATS parser job ${atsJobId}`);
          try {
            await runAtsParserJob(atsJobId);
          } catch (err) {
            log('error', `ATS parser job ${atsJobId} crashed`, err);
          }
        })();
        running.add(task);
        void task.finally(() => {
          running.delete(task);
          atsJobActive = false;
        });
        return true;
      }
    }

    // Архив и Директ — через жизненный цикл, по одной задаче на очередь.
    //
    // Опрашиваем ОБА раннера и только потом складываем ответы. Короткое
    // замыкание (`a.pollOnce() || b.pollOnce()`) здесь — starvation: pollOnce
    // отвечает true не только когда задачу взяли, но и когда все слоты заняты
    // (lifecycle.ts: спит 500 мс и возвращает true, чтобы цикл не ушёл спать на
    // 30 с). Оба раннера идут с concurrency=1, поэтому с момента захвата
    // архивной задачи и до её конца — часами на архиве в 50 тысяч — первый
    // pollOnce возвращал бы true каждый тик, а до второго очередь не доходила
    // бы вовсе: pending-задача Директа просто стояла бы. Прежние два мьютекса
    // проверялись независимо, так что это была бы регрессия.
    const archivePolled = await archiveRunner.pollOnce();
    const directPolled = await directRunner.pollOnce();
    if (archivePolled || directPolled) return true;

    if (running.size >= MAX_CONCURRENCY) {
      await sleep(250);
      return true;
    }
    return false;
  };

  let stopFired = false;
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      if (stopFired) return;
      stopFired = true;
      // markShuttingDown синхронно, ДО любой async-работы: shutdown() ставит
      // флаг и сам, но полагаться на то, что он успеет до первого await внутри
      // библиотеки, нельзя — флаг читают из другого модуля.
      markShuttingDown();
      log('info', `${sig} received — releasing leases for fast handoff`);
      void Promise.all([archiveRunner.shutdown(), directRunner.shutdown()])
        .catch((err) => log('error', 'shutdown failed', err));
    });
  }

  await pollLoop({
    log,
    pollIntervalMs: POLL_INTERVAL_MS,
    shouldStop,
    pollOnce,
    realtimeTables: ['parser_jobs', 'hh_archive_jobs', 'yandex_direct_jobs'],
  });
  await Promise.all([archiveRunner.shutdown(), directRunner.shutdown()]);
  log('info', 'Worker stopped');
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});

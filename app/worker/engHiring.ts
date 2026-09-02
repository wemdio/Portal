/**
 * ENG hiring worker — одна очередь: `parser_jobs` с parser_type='eng_hiring'.
 *
 * 02.09.2026: на едином жизненном цикле задач (lib/jobs/lifecycle.ts). Захват
 * идёт с фильтром по типу парсера, поэтому воркер физически не может взять
 * HH- или ATS-задачу, а HH-воркер — задачу найма. Восстановление при старте
 * (running → pending по своему типу) снято: брошенную задачу определяет
 * истёкшая аренда, а прежний сброс бил и по строкам, которые прямо сейчас
 * выполняла живая соседняя реплика. Мьютекс engHiringJobActive заменён
 * concurrency: 1 у раннера.
 *
 * Курсора у задачи нет — подобранная проходит заново; кэш бордов при этом не
 * теряется, у eng_hiring_cache_runs собственное продолжение по
 * next_company_index (см. докблок createParserJobRunner).
 */

import { runEngHiringParserJob } from '@/lib/parsers/engHiringRunner';
import { markShuttingDown } from '@/lib/workerShutdown';
import { createWorkerLogger, pollLoop, requireSupabaseAdmin, setupGracefulShutdown } from './_shared';
import { createParserJobRunner } from './parserJobs';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '5000');
const WORKER_ID = `eng-hiring-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);

async function main(): Promise<void> {
  log('info', `Starting ENG hiring worker (pid=${process.pid})`);
  requireSupabaseAdmin(log);
  const shouldStop = setupGracefulShutdown(log);

  const runner = createParserJobRunner({
    parserTypes: ['eng_hiring'],
    workerId: WORKER_ID,
    log,
    // Один прогон за раз: сканирование бордов идёт пачками по десятку запросов,
    // а у Workday пейсинг подобран под его WAF. Раньше то же обеспечивал
    // мьютекс engHiringJobActive.
    concurrency: 1,
    run: async (jobId, ctx) => {
      log('info', `Running ENG hiring parser job ${jobId}`);
      await runEngHiringParserJob(jobId, { signal: ctx.signal, runToken: ctx.runToken });
    },
  });

  let stopFired = false;
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      if (stopFired) return;
      stopFired = true;
      // markShuttingDown синхронно, ДО любой async-работы: флаг читают из
      // другого модуля, и полагаться на shutdown() внутри библиотеки нельзя.
      markShuttingDown();
      log('info', `${sig} received — releasing lease for fast handoff`);
      void runner.shutdown().catch((err) => log('error', 'shutdown failed', err));
    });
  }

  await pollLoop({
    log,
    pollIntervalMs: POLL_INTERVAL_MS,
    shouldStop,
    pollOnce: () => runner.pollOnce(),
    realtimeTables: ['parser_jobs'],
  });
  await runner.shutdown();
  log('info', 'Worker stopped');
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});

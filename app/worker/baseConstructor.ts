/**
 * BaseConstructor worker — «Конструктор баз» в отдельном долгоживущем контейнере.
 *
 * Владение задачей — через единый жизненный цикл (lib/jobs/lifecycle.ts):
 * захват pending или задачи с истёкшей/обнулённой арендой, продление аренды по
 * таймеру, на SIGTERM — обнуление аренды, чтобы соседняя реплика подобрала job
 * на ближайшем опросе, а не через порог простоя.
 *
 * Сам runner (runBaseConstructorJob) не менялся: он по-прежнему пишет
 * терминальный статус сам, ограждает записи run_token'ом и продвигает
 * started_at как heartbeat прогресса для монитора здоровья. Поэтому
 * manageTerminalStatus=false.
 *
 * Резюм с чекпойнта живёт внутри runBaseConstructorJob (current_step /
 * current_step_progress / data), отдельный checkpoint-столбец тут не нужен.
 *
 * Undici-ассерт (инцидент 19.06.2026): при массовом скрейпинге в find_emails
 * парсер undici роняет весь процесс синхронным ассертом из обработчика сокета,
 * который не ловится try/catch вокруг fetch. installUndiciAssertGuard глушит
 * именно его — иначе контейнер падал на одном и том же URL по кругу.
 */

import { runBaseConstructorJob } from '@/lib/tools/baseConstructorWorker';
import { createJobRunner } from '@/lib/jobs/lifecycle';
import { markShuttingDown } from '@/lib/workerShutdown';
import {
  createWorkerLogger,
  pollLoop,
  requireSupabaseAdmin,
  setupGracefulShutdown,
} from './_shared';
import { installUndiciAssertGuard } from './_undiciAssertGuard';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '5000');
/** Сколько job'ов параллельно один воркер берёт. Память: 1 job ≈ 0.5–1.5GB JS heap. */
const MAX_CONCURRENCY = Math.max(1, Number(process.env.BASE_CONSTRUCTOR_CONCURRENCY ?? '2'));
/**
 * Аренда. Продление идёт независимым таймером каждые lease/3, а не по тикам
 * прогресса, так что порог можно держать коротким: 5 минут = ~3 пропущенных
 * продления. Чистый redeploy аренду обнуляет сразу, порога не ждёт.
 */
const LEASE_SECONDS = Math.max(60, Number(process.env.BASE_CONSTRUCTOR_LEASE_SECONDS ?? '300'));
const WORKER_ID = `baseconstructor-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);

async function main(): Promise<void> {
  log(
    'info',
    `Starting BaseConstructor worker (pid=${process.pid}, concurrency=${MAX_CONCURRENCY}, lease=${LEASE_SECONDS}s)`,
  );
  installUndiciAssertGuard(log);
  requireSupabaseAdmin(log);
  const shouldStop = setupGracefulShutdown(log);

  const runner = createJobRunner<{ id: string }, never>({
    table: 'base_constructor_jobs',
    workerId: WORKER_ID,
    statuses: { pending: 'pending', running: 'processing', done: 'completed', failed: 'failed' },
    leaseSeconds: LEASE_SECONDS,
    concurrency: MAX_CONCURRENCY,
    manageTerminalStatus: false,
    claimPatch: () => ({ started_at: new Date().toISOString() }),
    failedPatch: (reason) => ({ error_message: reason, completed_at: new Date().toISOString() }),
    log,
    run: async (job, ctx) => {
      log('info', `Running base-constructor job ${job.id}`);
      await runBaseConstructorJob(job.id, ctx.runToken);
      log('info', `Finished base-constructor job ${job.id}`);
    },
  });

  let stopFired = false;
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      if (stopFired) return;
      stopFired = true;
      // markShuttingDown синхронно, ДО любой async-работы: shutdown() тоже
      // ставит этот флаг, но полагаться на то, что он стоит до первого await
      // внутри библиотеки, нельзя — от этого зависит heartbeat конструктора
      // баз (updateJobProgress перестаёт трогать started_at), а он живёт в
      // другом модуле и крутится всё время docker stop grace. Вызов
      // идемпотентный, флаг односторонний — лишним он быть не может.
      markShuttingDown();
      log('info', `${sig} received — releasing leases for fast handoff`);
      void runner.shutdown().catch((err) => log('error', 'shutdown failed', err));
    });
  }

  await pollLoop({
    log,
    pollIntervalMs: POLL_INTERVAL_MS,
    shouldStop,
    pollOnce: () => runner.pollOnce(),
    realtimeTables: ['base_constructor_jobs'],
  });
  await runner.shutdown();
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});

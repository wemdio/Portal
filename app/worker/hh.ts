import { runHHParserJob } from '@/lib/parsers/hhRunner';
import { runHHArchiveJob } from '@/lib/parsers/hhArchive/runner';
import { createWorkerLogger, pollLoop, requireSupabaseAdmin, setupGracefulShutdown, sleep } from './_shared';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '5000');
const MAX_CONCURRENCY = 3;
const DRAIN_TIMEOUT_MS = Number(process.env.WORKER_DRAIN_TIMEOUT_MINUTES ?? '180') * 60 * 1000;
const WORKER_ID = `hh-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);
const running = new Set<Promise<void>>();
// Архивные job'ы обрабатываются строго по одному за раз: rate-limit HH общий
// на IP, параллельные запросы к api.hh.ru от нескольких потоков → быстрый
// бан. Обычные HTML-парс задачи (parser_jobs) могут бежать MAX_CONCURRENCY=3
// параллельно, потому что hh.ru/search/vacancy менее agressive на rate.
let archiveJobActive = false;

async function startupRecovery(): Promise<void> {
  const db = requireSupabaseAdmin(log);
  const { data: hhJobs, error: hhErr } = await db
    .from('parser_jobs')
    .update({ status: 'pending' })
    .eq('status', 'running')
    .select('id');
  if (hhErr) log('warn', 'Startup recovery: parser_jobs update failed', hhErr);
  else if (hhJobs?.length) log('info', `Startup recovery: reset ${hhJobs.length} parser_jobs to pending`);

  // Архивные processing-задачи без heartbeat — сбрасываем в pending для повторного клейма.
  // Heartbeat-cutoff 30 мин: реальная работа на чанке = 1-2 минуты, 30 мин без
  // прогресса = воркер умер.
  const cutoffIso = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data: archiveJobs, error: archiveErr } = await db
    .from('hh_archive_jobs')
    .update({ status: 'pending' })
    .eq('status', 'processing')
    .lt('updated_at', cutoffIso)
    .select('id');
  if (archiveErr) log('warn', 'Startup recovery: hh_archive_jobs update failed', archiveErr);
  else if (archiveJobs?.length) log('info', `Startup recovery: reset ${archiveJobs.length} hh_archive_jobs to pending`);
}

async function claimHHJob(): Promise<string | null> {
  const db = requireSupabaseAdmin(log);

  const { data: pending } = await db
    .from('parser_jobs')
    .select('id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!pending) return null;

  const { data: claimed } = await db
    .from('parser_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();

  return claimed?.id ?? null;
}

/**
 * Атомарно клеймит один pending hh_archive_jobs. Глобальная concurrency=1
 * (HH rate-limit shared по IP), поэтому проверяем archiveJobActive флаг.
 */
async function claimHHArchiveJob(): Promise<string | null> {
  if (archiveJobActive) return null;
  const db = requireSupabaseAdmin(log);

  const { data: pending } = await db
    .from('hh_archive_jobs')
    .select('id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!pending) return null;

  const { data: claimed } = await db
    .from('hh_archive_jobs')
    .update({ status: 'processing', started_at: new Date().toISOString() })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  return claimed?.id ?? null;
}

async function pollOnce(): Promise<boolean> {
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

  // Архив — глобально один на воркер.
  if (!archiveJobActive) {
    const archiveJobId = await claimHHArchiveJob();
    if (archiveJobId) {
      archiveJobActive = true;
      const task = (async () => {
        log('info', `Running HH archive job ${archiveJobId}`);
        try {
          const db = requireSupabaseAdmin(log);
          await runHHArchiveJob(db, archiveJobId);
        } catch (err) {
          log('error', `HH archive job ${archiveJobId} crashed`, err);
        }
      })();
      running.add(task);
      void task.finally(() => {
        running.delete(task);
        archiveJobActive = false;
      });
      return true;
    }
  }

  if (running.size >= MAX_CONCURRENCY) {
    await sleep(250);
    return true;
  }
  return false;
}

async function main(): Promise<void> {
  log('info', `Starting HH worker (pid=${process.pid})`);
  requireSupabaseAdmin(log);
  const shouldStop = setupGracefulShutdown(log);

  log('info', 'Running startup recovery...');
  await startupRecovery();
  log('info', 'Startup recovery done');

  await pollLoop({
    log,
    pollIntervalMs: POLL_INTERVAL_MS,
    shouldStop,
    pollOnce,
    realtimeTables: ['parser_jobs', 'hh_archive_jobs'],
  });
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});


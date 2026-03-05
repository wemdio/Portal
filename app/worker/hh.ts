import { runHHParserJob } from '@/lib/parsers/hhRunner';
import { createWorkerLogger, pollLoop, requireSupabaseAdmin, setupGracefulShutdown, sleep } from './_shared';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '3000');
const MAX_CONCURRENCY = 3;
const DRAIN_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const WORKER_ID = `hh-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);
const running = new Set<Promise<void>>();

async function startupRecovery(): Promise<void> {
  const db = requireSupabaseAdmin(log);
  const now = new Date().toISOString();
  const errorMsg = 'Прервано перезапуском worker-сервиса';

  const { data: hhJobs, error: hhErr } = await db
    .from('parser_jobs')
    .update({ status: 'failed', completed_at: now, error_message: errorMsg, progress_stage: 'failed' })
    .eq('status', 'running')
    .select('id');
  if (hhErr) log('warn', 'Startup recovery: parser_jobs update failed', hhErr);
  else if (hhJobs?.length) log('info', `Startup recovery: marked ${hhJobs.length} parser_jobs as failed`);
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

async function pollOnce(): Promise<boolean> {
  if (running.size >= MAX_CONCURRENCY) {
    // Avoid hot loop when worker is at capacity.
    await sleep(250);
    return true;
  }
  const jobId = await claimHHJob();
  if (!jobId) return false;
  const task = (async () => {
    log('info', `Running HH parser job ${jobId}`);
    await runHHParserJob(jobId, DRAIN_TIMEOUT_MS);
  })();
  running.add(task);
  void task.finally(() => running.delete(task));
  return true;
}

async function main(): Promise<void> {
  log('info', `Starting HH worker (pid=${process.pid})`);
  requireSupabaseAdmin(log);
  const shouldStop = setupGracefulShutdown(log);

  log('info', 'Running startup recovery...');
  await startupRecovery();
  log('info', 'Startup recovery done');

  await pollLoop({ log, pollIntervalMs: POLL_INTERVAL_MS, shouldStop, pollOnce });
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});


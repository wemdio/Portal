import { runTgParserJob } from '@/lib/tgParser/tgParserJobWorker';
import { createWorkerLogger, pollLoop, requireSupabaseAdmin, setupGracefulShutdown, sleep } from './_shared';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '5000');
const MAX_CONCURRENCY = 1;
const WORKER_ID = `tg-parser-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);
const running = new Set<Promise<void>>();

async function startupRecovery(): Promise<void> {
  const db = requireSupabaseAdmin(log);
  const { data: jobs, error } = await db
    .from('tg_parser_jobs')
    .update({ status: 'pending' })
    .eq('status', 'running')
    .select('id');
  if (error) log('warn', 'Startup recovery: tg_parser_jobs update failed', error);
  else if (jobs?.length) log('info', `Startup recovery: reset ${jobs.length} tg_parser_jobs to pending`);
}

async function claimJob(): Promise<string | null> {
  const db = requireSupabaseAdmin(log);
  const { data: pending } = await db
    .from('tg_parser_jobs')
    .select('id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!pending) return null;

  const { data: claimed } = await db
    .from('tg_parser_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  return claimed?.id ?? null;
}

async function pollOnce(): Promise<boolean> {
  if (running.size >= MAX_CONCURRENCY) {
    await sleep(500);
    return true;
  }
  const jobId = await claimJob();
  if (!jobId) return false;
  const task = (async () => {
    log('info', `Running TG parser job ${jobId}`);
    await runTgParserJob(jobId);
  })();
  running.add(task);
  void task.finally(() => running.delete(task));
  return true;
}

async function main(): Promise<void> {
  log('info', `Starting TG User Parser worker (pid=${process.pid})`);
  requireSupabaseAdmin(log);

  log('info', 'Running startup recovery...');
  await startupRecovery();
  log('info', 'Startup recovery done');

  const shouldStop = setupGracefulShutdown(log);
  await pollLoop({
    log,
    pollIntervalMs: POLL_INTERVAL_MS,
    shouldStop,
    pollOnce,
    realtimeTables: ['tg_parser_jobs'],
  });
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});

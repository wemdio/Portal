import { runGoogleMapsJob, runGoogleNewsJob } from '@/../lib/parsers/googleParsersWorker';
import { createWorkerLogger, pollLoop, requireSupabaseAdmin, setupGracefulShutdown, sleep } from './_shared';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '5000');
const MAX_CONCURRENCY = Number(process.env.GOOGLEPARSERS_CONCURRENCY ?? '1');
const WORKER_ID = `googleparsers-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);
const running = new Set<Promise<void>>();

async function startupRecovery(): Promise<void> {
  const db = requireSupabaseAdmin(log);
  for (const table of ['google_maps_jobs', 'google_news_jobs'] as const) {
    const { data, error } = await db
      .from(table)
      .update({ status: 'queued' })
      .eq('status', 'running')
      .select('id');
    if (error) log('warn', `Startup recovery: ${table} update failed`, error);
    else if (data?.length) log('info', `Startup recovery: reset ${data.length} rows in ${table} to queued`);
  }
}

type Claim = { id: string; kind: 'maps' | 'news' };

async function claim(): Promise<Claim | null> {
  const db = requireSupabaseAdmin(log);
  for (const [table, kind] of [
    ['google_maps_jobs', 'maps'],
    ['google_news_jobs', 'news'],
  ] as const) {
    const { data: pending } = await db
      .from(table)
      .select('id')
      .eq('status', 'queued')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!pending) continue;
    const { data: claimed } = await db
      .from(table)
      .update({ status: 'running', started_at: new Date().toISOString() })
      .eq('id', pending.id)
      .eq('status', 'queued')
      .select('id')
      .maybeSingle();
    if (claimed) return { id: claimed.id as string, kind };
  }
  return null;
}

async function pollOnce(): Promise<boolean> {
  if (running.size >= MAX_CONCURRENCY) {
    await sleep(500);
    return true;
  }
  const job = await claim();
  if (!job) return false;
  const task = (async () => {
    try {
      log('info', `Running Google ${job.kind} job ${job.id}`);
      if (job.kind === 'maps') await runGoogleMapsJob(job.id);
      else await runGoogleNewsJob(job.id);
    } catch (err) {
      log('error', `Job ${job.id} (${job.kind}) crashed`, err);
      const db = requireSupabaseAdmin(log);
      await db
        .from(job.kind === 'maps' ? 'google_maps_jobs' : 'google_news_jobs')
        .update({ status: 'failed', error_message: err instanceof Error ? err.message : String(err) })
        .eq('id', job.id);
    }
  })();
  running.add(task);
  void task.finally(() => running.delete(task));
  return true;
}

async function main(): Promise<void> {
  log('info', `Starting GoogleParsers worker (pid=${process.pid})`);
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
    realtimeTables: ['google_maps_jobs', 'google_news_jobs'],
  });
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});

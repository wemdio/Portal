import { runYandexMapsCollectLinks, runYandexMapsParseOrganizations } from '@/lib/parsers/yandexMapsWorker';
import { createWorkerLogger, pollLoop, requireSupabaseAdmin, setupGracefulShutdown, sleep } from './_shared';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '5000');
const MAX_CONCURRENCY = 1;
const WORKER_ID = `yandexmaps-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);
const running = new Set<Promise<void>>();

async function startupRecovery(): Promise<void> {
  const db = requireSupabaseAdmin(log);
  const { data: jobs, error } = await db
    .from('yandex_maps_jobs')
    .update({ status: 'pending' })
    .eq('status', 'running')
    .select('id');
  if (error) log('warn', 'Startup recovery: yandex_maps_jobs update failed', error);
  else if (jobs?.length) log('info', `Startup recovery: reset ${jobs.length} yandex_maps_jobs to pending`);
}

async function claimYandexMapsJob(): Promise<{ id: string; stage: 'collect' | 'parse' } | null> {
  const db = requireSupabaseAdmin(log);
  const { data: pending } = await db
    .from('yandex_maps_jobs')
    .select('id, progress_stage')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!pending) return null;

  const { data: claimed } = await db
    .from('yandex_maps_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id, progress_stage')
    .maybeSingle();

  if (!claimed) return null;
  const stageValue = String(claimed.progress_stage ?? 'pending');
  const stage =
    stageValue === 'ready_to_parse' ||
    stageValue === 'links_collected' ||
    stageValue.startsWith('parsing_organizations')
      ? 'parse'
      : 'collect';
  return { id: claimed.id as string, stage };
}

async function pollOnce(): Promise<boolean> {
  if (running.size >= MAX_CONCURRENCY) {
    await sleep(500);
    return true;
  }
  const job = await claimYandexMapsJob();
  if (!job) return false;
  const task = (async () => {
    if (job.stage === 'collect') {
      log('info', `Running YandexMaps collect-links job ${job.id}`);
      await runYandexMapsCollectLinks(job.id);
    } else {
      log('info', `Running YandexMaps parse-orgs job ${job.id}`);
      await runYandexMapsParseOrganizations(job.id);
    }
  })();
  running.add(task);
  void task.finally(() => running.delete(task));
  return true;
}

async function main(): Promise<void> {
  log('info', `Starting YandexMaps worker (pid=${process.pid})`);
  requireSupabaseAdmin(log);
  const shouldStop = setupGracefulShutdown(log);

  log('info', 'Running startup recovery...');
  await startupRecovery();
  log('info', 'Startup recovery done');

  await pollLoop({ log, pollIntervalMs: POLL_INTERVAL_MS, shouldStop, pollOnce, realtimeTables: ['yandex_maps_jobs'] });
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});


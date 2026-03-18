import { runSearchParserJob } from '@/lib/parsers/searchParserWorker';
import { createWorkerLogger, pollLoop, requireSupabaseAdmin, setupGracefulShutdown, sleep } from './_shared';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '5000');
const MAX_CONCURRENCY = 3;
const WORKER_ID = `search-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);
const running = new Set<Promise<void>>();

async function startupRecovery(): Promise<void> {
  const db = requireSupabaseAdmin(log);
  const now = new Date().toISOString();
  const errorMsg = 'Прервано перезапуском worker-сервиса';

  const searchUpdate = await db
    .from('search_parser_jobs')
    .update({ status: 'failed', completed_at: now, error_message: errorMsg, progress_stage: 'failed' })
    .eq('status', 'running')
    .select('id');
  const searchErr = searchUpdate.error as { code?: string; message?: string } | null;
  if (searchErr?.code === 'PGRST204' && (searchErr.message ?? '').includes("progress_stage")) {
    const fallbackUpdate = await db
      .from('search_parser_jobs')
      .update({ status: 'failed', completed_at: now, error_message: errorMsg })
      .eq('status', 'running')
      .select('id');
    if (fallbackUpdate.error) log('warn', 'Startup recovery: search_parser_jobs update failed', fallbackUpdate.error);
    else if (fallbackUpdate.data?.length) {
      log('info', `Startup recovery: marked ${fallbackUpdate.data.length} search_parser_jobs as failed`);
    }
    return;
  }

  if (searchUpdate.error) log('warn', 'Startup recovery: search_parser_jobs update failed', searchUpdate.error);
  else if (searchUpdate.data?.length) {
    log('info', `Startup recovery: marked ${searchUpdate.data.length} search_parser_jobs as failed`);
  }
}

async function claimSearchJob(): Promise<string | null> {
  const db = requireSupabaseAdmin(log);

  const { data: pending } = await db
    .from('search_parser_jobs')
    .select('id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!pending) return null;

  const { data: claimed } = await db
    .from('search_parser_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();

  return claimed?.id ?? null;
}

async function pollOnce(): Promise<boolean> {
  if (running.size >= MAX_CONCURRENCY) {
    await sleep(350);
    return true;
  }
  const jobId = await claimSearchJob();
  if (!jobId) return false;
  const task = (async () => {
    log('info', `Running search parser job ${jobId}`);
    await runSearchParserJob(jobId);
  })();
  running.add(task);
  void task.finally(() => running.delete(task));
  return true;
}

async function main(): Promise<void> {
  log('info', `Starting Search worker (pid=${process.pid})`);
  requireSupabaseAdmin(log);
  const shouldStop = setupGracefulShutdown(log);

  log('info', 'Running startup recovery...');
  await startupRecovery();
  log('info', 'Startup recovery done');

  await pollLoop({ log, pollIntervalMs: POLL_INTERVAL_MS, shouldStop, pollOnce, realtimeTables: ['search_parser_jobs'] });
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});


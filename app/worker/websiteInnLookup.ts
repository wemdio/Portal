/** Dedicated worker for background «Найти ИНН по сайту» spreadsheet jobs. */

import { runWebsiteInnLookupJob } from '@/lib/enrich/websiteInnLookupRunner';
import { createWorkerLogger, pollLoop, requireSupabaseAdmin, setupGracefulShutdown, sleep } from './_shared';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '5000');
const WORKER_ID = `websiteinnlookup-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);
const running = new Set<Promise<void>>();

async function startupRecovery(): Promise<void> {
  const db = requireSupabaseAdmin(log);
  const now = new Date().toISOString();
  const { data: items, error: itemsError } = await db
    .from('website_inn_lookup_items')
    .update({ status: 'pending', started_at: null, updated_at: now })
    .eq('status', 'running')
    .select('id');
  if (itemsError) log('warn', 'Startup recovery: item reset failed', itemsError);
  else if (items?.length) log('info', `Startup recovery: reset ${items.length} items to pending`);

  const { data: jobs, error: jobsError } = await db
    .from('website_inn_lookup_jobs')
    .update({ status: 'pending', updated_at: now })
    .eq('status', 'running')
    .select('id');
  if (jobsError) log('warn', 'Startup recovery: job reset failed', jobsError);
  else if (jobs?.length) log('info', `Startup recovery: reset ${jobs.length} jobs to pending`);
}

async function claimJob(): Promise<string | null> {
  const db = requireSupabaseAdmin(log);
  const { data: pending, error: pendingError } = await db
    .from('website_inn_lookup_jobs')
    .select('id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (pendingError) throw new Error(pendingError.message);
  if (!pending) return null;

  const now = new Date().toISOString();
  const { data: claimed, error: claimError } = await db
    .from('website_inn_lookup_jobs')
    .update({ status: 'running', started_at: now, updated_at: now })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (claimError) throw new Error(claimError.message);
  return claimed?.id ?? null;
}

async function pollOnce(): Promise<boolean> {
  if (running.size > 0) {
    await sleep(500);
    return true;
  }
  const jobId = await claimJob();
  if (!jobId) return false;
  const task = (async () => {
    log('info', `Running website INN lookup job ${jobId}`);
    await runWebsiteInnLookupJob(jobId);
  })();
  running.add(task);
  void task.finally(() => running.delete(task));
  return true;
}

async function main(): Promise<void> {
  log('info', `Starting Website INN Lookup worker (pid=${process.pid})`);
  requireSupabaseAdmin(log);
  const shouldStop = setupGracefulShutdown(log);
  await startupRecovery();
  await pollLoop({
    log,
    pollIntervalMs: POLL_INTERVAL_MS,
    shouldStop,
    pollOnce,
    realtimeTables: ['website_inn_lookup_jobs'],
  });
}

main().catch((error) => {
  log('error', 'Worker crashed', error);
  process.exit(1);
});

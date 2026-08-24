/** Dedicated worker for background «Найти ИНН по сайту» spreadsheet jobs. */

import { runWebsiteInnLookupJob } from '@/lib/enrich/websiteInnLookupRunner';
import { createWorkerLogger, pollLoop, requireSupabaseAdmin, setupGracefulShutdown, sleep } from './_shared';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '5000');
const PREPARING_STALE_MS = 10 * 60 * 1000;
const PREPARING_RECOVERY_INTERVAL_MS = 60 * 1000;
const WORKER_ID = `websiteinnlookup-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);
const running = new Set<Promise<void>>();
let nextPreparingRecoveryAt = 0;

async function recoverStalePreparingJobs(): Promise<void> {
  const db = requireSupabaseAdmin(log);
  // API публикует очередь в две фазы: preparing → insert all items → pending.
  // Если API-контейнер умер между фазами, worker не должен ни взять частичную
  // очередь, ни оставить пользователя заблокированным навсегда. Свежие
  // preparing не трогаем: их ещё может наполнять живой API request.
  const preparingCutoff = new Date(Date.now() - PREPARING_STALE_MS).toISOString();
  const { data: stalePreparing, error: preparingError } = await db
    .from('website_inn_lookup_jobs')
    .select('id, total, updated_at')
    .eq('status', 'preparing')
    .lt('updated_at', preparingCutoff);
  if (preparingError) {
    log('warn', 'Preparing job recovery scan failed', preparingError);
    return;
  }

  for (const job of stalePreparing ?? []) {
    const { count, error: countError } = await db
      .from('website_inn_lookup_items')
      .select('id', { count: 'exact', head: true })
      .eq('job_id', job.id);
    if (countError) {
      log('warn', `Could not count items for preparing job ${job.id}`, countError);
      continue;
    }

    const persisted = count ?? 0;
    const complete = persisted === job.total;
    const recoveredAt = new Date().toISOString();
    const { data: recovered, error: recoveryError } = await db
      .from('website_inn_lookup_jobs')
      .update(complete
        ? { status: 'pending', updated_at: recoveredAt }
        : {
            status: 'failed',
            error_message: `Queue preparation interrupted: ${persisted}/${job.total}`,
            completed_at: recoveredAt,
            updated_at: recoveredAt,
          })
      .eq('id', job.id)
      .eq('status', 'preparing')
      .eq('updated_at', job.updated_at)
      .select('id');
    if (recoveryError) {
      log('warn', `Preparing job ${job.id} recovery failed`, recoveryError);
    } else if (recovered?.length) {
      log(
        complete ? 'info' : 'warn',
        complete
          ? `Published complete preparing job ${job.id}`
          : `Failed incomplete preparing job ${job.id} (${persisted}/${job.total})`,
      );
    }
  }
}

async function startupRecovery(): Promise<void> {
  const db = requireSupabaseAdmin(log);
  const now = new Date().toISOString();
  await recoverStalePreparingJobs();
  nextPreparingRecoveryAt = Date.now() + PREPARING_RECOVERY_INTERVAL_MS;

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
  if (Date.now() >= nextPreparingRecoveryAt) {
    await recoverStalePreparingJobs();
    nextPreparingRecoveryAt = Date.now() + PREPARING_RECOVERY_INTERVAL_MS;
  }
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

import { runWebsiteEnrichmentJob } from '@/lib/enrich/websiteEnrichmentWorker';
import { runBriefScoringJob } from '@/lib/briefScoring/briefScoringWorker';
import { runCryptoPaymentJob } from '@/lib/parsers/cryptoPaymentsWorker';
import { createWorkerLogger, pollLoop, requireSupabaseAdmin, setupGracefulShutdown, sleep } from './_shared';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '5000');
const MAX_CONCURRENCY = 2;
const STALE_JOB_MINUTES = Number(process.env.ENRICH_STALE_JOB_MINUTES ?? '10');
const WATCHDOG_INTERVAL_MS = 60_000;
const WORKER_ID = `enrich-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);
const running = new Set<Promise<void>>();
const jobProgress = new Map<string, { processed: number; checkedAt: number }>();

async function startupRecovery(): Promise<void> {
  const db = requireSupabaseAdmin(log);
  // Website enrichment — сбрасываем в 'pending' (воркер сам продолжит с места остановки)
  const { data: jobs, error } = await db
    .from('website_enrichment_jobs')
    .update({ status: 'pending' })
    .eq('status', 'running')
    .select('id');
  if (error) log('warn', 'Startup recovery: website_enrichment_jobs update failed', error);
  else if (jobs?.length) log('info', `Startup recovery: reset ${jobs.length} website_enrichment_jobs to pending`);

  const { data: briefJobs, error: briefError } = await db
    .from('brief_scoring_jobs')
    .update({ status: 'pending' })
    .eq('status', 'running')
    .select('id');
  if (briefError) log('warn', 'Startup recovery: brief_scoring_jobs update failed', briefError);
  else if (briefJobs?.length) log('info', `Startup recovery: reset ${briefJobs.length} brief_scoring_jobs to pending`);

  // Crypto payment jobs — reset running to pending (worker resumes from checked_count)
  const { data: cryptoJobs, error: cryptoError } = await db
    .from('crypto_payment_jobs')
    .update({ status: 'pending', updated_at: new Date().toISOString() })
    .eq('status', 'running')
    .select('id');
  if (cryptoError) log('warn', 'Startup recovery: crypto_payment_jobs update failed', cryptoError);
  else if (cryptoJobs?.length) log('info', `Startup recovery: reset ${cryptoJobs.length} crypto_payment_jobs to pending`);
}

async function claimEnrichJob(): Promise<string | null> {
  const db = requireSupabaseAdmin(log);
  const { data: pending } = await db
    .from('website_enrichment_jobs')
    .select('id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!pending) return null;

  const { data: claimed } = await db
    .from('website_enrichment_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();

  return claimed?.id ?? null;
}

async function claimBriefScoringJob(): Promise<string | null> {
  const db = requireSupabaseAdmin(log);
  const { data: pending } = await db
    .from('brief_scoring_jobs')
    .select('id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!pending) return null;

  const { data: claimed } = await db
    .from('brief_scoring_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();

  return claimed?.id ?? null;
}

async function claimCryptoPaymentJob(): Promise<string | null> {
  const db = requireSupabaseAdmin(log);
  const { data: pending } = await db
    .from('crypto_payment_jobs')
    .select('id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!pending) return null;

  const { data: claimed } = await db
    .from('crypto_payment_jobs')
    .update({ status: 'running', updated_at: new Date().toISOString() })
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
  const jobId = await claimEnrichJob();
  if (jobId) {
    const task = (async () => {
      log('info', `Running website enrichment job ${jobId}`);
      await runWebsiteEnrichmentJob(jobId);
    })();
    running.add(task);
    void task.finally(() => running.delete(task));
    return true;
  }

  const briefJobId = await claimBriefScoringJob();
  if (briefJobId) {
    const task = (async () => {
      log('info', `Running brief scoring job ${briefJobId}`);
      await runBriefScoringJob(briefJobId);
    })();
    running.add(task);
    void task.finally(() => running.delete(task));
    return true;
  }

  const cryptoJobId = await claimCryptoPaymentJob();
  if (!cryptoJobId) return false;

  const task = (async () => {
    log('info', `Running crypto payment job ${cryptoJobId}`);
    await runCryptoPaymentJob(cryptoJobId);
  })();
  running.add(task);
  void task.finally(() => running.delete(task));
  return true;
}

async function watchdog(): Promise<void> {
  const db = requireSupabaseAdmin(log);
  try {
    const { data: runningJobs } = await db
      .from('website_enrichment_jobs')
      .select('id, processed')
      .eq('status', 'running');

    if (!runningJobs?.length) {
      jobProgress.clear();
      return;
    }

    const staleMs = STALE_JOB_MINUTES * 60_000;
    const now = Date.now();

    for (const job of runningJobs) {
      const prev = jobProgress.get(job.id);
      if (prev && job.processed === prev.processed && now - prev.checkedAt > staleMs) {
        log('warn', `Watchdog: job ${job.id} stuck at ${job.processed} for ${STALE_JOB_MINUTES}+ min, resetting to pending`);
        await db
          .from('website_enrichment_jobs')
          .update({ status: 'pending' })
          .eq('id', job.id)
          .eq('status', 'running');
        jobProgress.delete(job.id);
      } else if (!prev || job.processed !== prev.processed) {
        jobProgress.set(job.id, { processed: job.processed, checkedAt: now });
      }
    }

    for (const id of jobProgress.keys()) {
      if (!runningJobs.some((j) => j.id === id)) jobProgress.delete(id);
    }
  } catch (err) {
    log('warn', 'Watchdog tick failed', err);
  }
}

async function main(): Promise<void> {
  log('info', `Starting Enrichment worker (pid=${process.pid})`);
  requireSupabaseAdmin(log);
  const shouldStop = setupGracefulShutdown(log);

  log('info', 'Running startup recovery...');
  await startupRecovery();
  log('info', 'Startup recovery done');

  const watchdogTimer = setInterval(() => { void watchdog(); }, WATCHDOG_INTERVAL_MS);

  await pollLoop({ log, pollIntervalMs: POLL_INTERVAL_MS, shouldStop, pollOnce, realtimeTables: ['website_enrichment_jobs', 'brief_scoring_jobs', 'crypto_payment_jobs'] });

  clearInterval(watchdogTimer);
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});


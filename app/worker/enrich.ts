import { runWebsiteEnrichmentJob } from '@/lib/enrich/websiteEnrichmentWorker';
import { runBriefScoringJob } from '@/lib/briefScoring/briefScoringWorker';
import { createWorkerLogger, pollLoop, requireSupabaseAdmin, setupGracefulShutdown, sleep } from './_shared';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '3000');
const MAX_CONCURRENCY = 2;
const WORKER_ID = `enrich-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);
const running = new Set<Promise<void>>();

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
  if (!briefJobId) return false;

  const task = (async () => {
    log('info', `Running brief scoring job ${briefJobId}`);
    await runBriefScoringJob(briefJobId);
  })();
  running.add(task);
  void task.finally(() => running.delete(task));
  return true;
}

async function main(): Promise<void> {
  log('info', `Starting Enrichment worker (pid=${process.pid})`);
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


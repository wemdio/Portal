/**
 * Sales AI Analysis worker — обрабатывает джобы из sales_ai_analysis_jobs.
 *
 * Паттерн — копия salesCopilot.ts: poll loop + realtime wake на INSERT
 * pending-джобы + graceful shutdown. На старте сбрасывает застрявшие
 * 'running' (после рестарта пода) в 'failed', иначе после деплоя они
 * висят навсегда.
 *
 * Джобы создаются кроном (salesAiAnalysisCron.ts) раз в сутки в 3:00 MSK,
 * либо вручную через SQL / API если понадобится (пока API нет).
 */

import { createWorkerLogger, requireSupabaseAdmin, setupGracefulShutdown, pollLoop } from './_shared';
import { runPipeline } from '@/lib/salesAiAnalysis/pipeline';
import { syncRegulation, type ActiveRegulation } from '@/lib/salesAiAnalysis/regulation';

const WORKER_ID = `sales-ai-analysis-${process.pid}`;
const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS) || 5000;

const log = createWorkerLogger(WORKER_ID);
const db = requireSupabaseAdmin(log);
const shouldStop = setupGracefulShutdown(log);

// Регламент кэшируется на процесс — синкается при старте и раз в час.
let cachedRegulation: ActiveRegulation | null = null;
let regulationCachedAt = 0;
const REGULATION_TTL_MS = 60 * 60 * 1000;

async function getRegulation(): Promise<ActiveRegulation> {
  const now = Date.now();
  if (!cachedRegulation || now - regulationCachedAt > REGULATION_TTL_MS) {
    cachedRegulation = await syncRegulation(db);
    regulationCachedAt = now;
    log('info', `Regulation v${cachedRegulation.version} loaded (sha256=${cachedRegulation.body_sha256.slice(0, 12)}…)`);
  }
  return cachedRegulation;
}

async function resetStuckJobs() {
  const { data } = await db
    .from('sales_ai_analysis_jobs')
    .select('id')
    .eq('status', 'running');
  if (data?.length) {
    log('info', `Resetting ${data.length} stuck running jobs to failed`);
    await db
      .from('sales_ai_analysis_jobs')
      .update({
        status: 'failed',
        error_message: 'Worker restarted mid-job',
        finished_at: new Date().toISOString(),
      })
      .eq('status', 'running');
  }
}

interface Job { id: string; amo_lead_id: number; trigger: string; }

async function claimJob(): Promise<Job | null> {
  const { data: pending } = await db
    .from('sales_ai_analysis_jobs')
    .select('id, amo_lead_id, trigger')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!pending) return null;

  const { data: claimed } = await db
    .from('sales_ai_analysis_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', (pending as Job).id)
    .eq('status', 'pending')
    .select('id, amo_lead_id, trigger')
    .maybeSingle();
  return (claimed as Job | null) ?? null;
}

async function handleJob(job: Job) {
  log('info', `Analyzing lead ${job.amo_lead_id} (job ${job.id})`);
  const regulation = await getRegulation();

  const result = await runPipeline(db, job.amo_lead_id, { regulation });

  const update: {
    status: string;
    finished_at: string;
    skip_reason?: string;
    error_message?: string;
  } = {
    status: result.status,
    finished_at: new Date().toISOString(),
  };
  if (result.skip_reason) update.skip_reason = result.skip_reason;
  if (result.error_message) update.error_message = result.error_message;

  await db.from('sales_ai_analysis_jobs').update(update).eq('id', job.id);
  log('info', `Job ${job.id} → ${result.status}${result.skip_reason ? ` (${result.skip_reason})` : ''}`);
}

async function pollOnce(): Promise<boolean> {
  const job = await claimJob();
  if (!job) return false;
  try {
    await handleJob(job);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', `Job ${job.id} failed: ${msg}`);
    await db.from('sales_ai_analysis_jobs').update({
      status: 'failed',
      error_message: msg.slice(0, 500),
      finished_at: new Date().toISOString(),
    }).eq('id', job.id);
  }
  return true;
}

async function main() {
  log('info', 'Sales AI Analysis worker starting…');
  await resetStuckJobs();

  await pollLoop({
    log,
    pollIntervalMs: POLL_INTERVAL_MS,
    shouldStop,
    pollOnce,
    realtimeTables: ['sales_ai_analysis_jobs'],
  });

  log('info', 'Sales AI Analysis worker stopped');
  process.exit(0);
}

void main();

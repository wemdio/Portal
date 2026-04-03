import { createWorkerLogger, requireSupabaseAdmin, setupGracefulShutdown, pollLoop } from './_shared';
import { runCampaignLoop, refetchEmptyDialogs } from '@/lib/tgOutreach/campaignLoop';
import { startTrace } from '@/lib/tracer';

const WORKER_ID = `tg-outreach-${process.pid}`;
const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS) || 5000;
const _MAX_CONCURRENCY = 5;

const log = createWorkerLogger(WORKER_ID);
const db = requireSupabaseAdmin(log);
const shouldStop = setupGracefulShutdown(log);

const runningCampaigns = new Map<string, { stop: () => void; promise: Promise<void> }>();

async function resetStuckJobs() {
  const { data } = await db
    .from('tg_outreach_jobs')
    .select('id')
    .eq('status', 'running');

  if (data?.length) {
    log('info', `Resetting ${data.length} stuck running jobs to pending`);
    await db
      .from('tg_outreach_jobs')
      .update({ status: 'pending', error_message: null, started_at: null, finished_at: null })
      .eq('status', 'running');
  }
}

async function claimJob(): Promise<{ id: string; campaign_id: string; action: string } | null> {
  const { data: pending } = await db
    .from('tg_outreach_jobs')
    .select('id, campaign_id, action')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!pending) return null;

  const { data: claimed } = await db
    .from('tg_outreach_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id, campaign_id, action')
    .maybeSingle();

  return claimed ?? null;
}

async function handleStartJob(job: { id: string; campaign_id: string }) {
  const campaignId = job.campaign_id;

  if (runningCampaigns.has(campaignId)) {
    log('warn', `Campaign ${campaignId} already running, skipping start`);
    await db.from('tg_outreach_jobs').update({ status: 'completed', finished_at: new Date().toISOString() }).eq('id', job.id);
    return;
  }

  let stopRequested = false;
  const stopFn = () => { stopRequested = true; };

  const { data: campaign } = await db
    .from('tg_outreach_campaigns')
    .select('name, user_id')
    .eq('id', campaignId)
    .single();

  const trace = await startTrace({
    name: 'tg-outreach.campaign.run',
    input: {
      campaignId,
      campaignName: campaign?.name,
      route: 'tg_outreach_worker',
      userId: campaign?.user_id,
    },
    message: `TG Аутрич: ${campaign?.name ?? campaignId}`,
    userId: campaign?.user_id ?? null,
  });

  const requestId = trace?.traceId ?? crypto.randomUUID();
  if (trace) {
    await db
      .from('trace_spans')
      .update({ input: { campaignId, campaignName: campaign?.name, requestId, route: 'tg_outreach_worker', userId: campaign?.user_id } })
      .eq('id', trace.id);
  }

  const traceContext = trace ? { requestId } : undefined;

  const promise = runCampaignLoop(campaignId, db, () => shouldStop() || stopRequested, traceContext)
    .then(() => {
      log('info', `Campaign ${campaignId} loop finished`);
      void trace?.end({ status: 'stopped' });
    })
    .catch((err) => {
      log('error', `Campaign ${campaignId} loop error: ${err instanceof Error ? err.message : String(err)}`);
      void db.from('tg_outreach_campaigns').update({ status: 'error', updated_at: new Date().toISOString() }).eq('id', campaignId);
      void trace?.fail(err);
    })
    .finally(() => {
      runningCampaigns.delete(campaignId);
      void db.from('tg_outreach_jobs').update({ status: 'completed', finished_at: new Date().toISOString() }).eq('id', job.id);
    });

  runningCampaigns.set(campaignId, { stop: stopFn, promise });
  log('info', `Started campaign ${campaignId}`);
}

async function handleStopJob(job: { id: string; campaign_id: string }) {
  const campaignId = job.campaign_id;
  const running = runningCampaigns.get(campaignId);

  if (running) {
    running.stop();
    log('info', `Signaled stop for campaign ${campaignId}`);
    await running.promise;
  } else {
    await db.from('tg_outreach_campaigns').update({ status: 'stopped', updated_at: new Date().toISOString() }).eq('id', campaignId);
  }

  await db.from('tg_outreach_jobs').update({ status: 'completed', finished_at: new Date().toISOString() }).eq('id', job.id);
}

async function handleRestartJob(job: { id: string; campaign_id: string }) {
  await handleStopJob(job);
  await handleStartJob(job);
}

async function handleRefetchJob(job: { id: string; campaign_id: string }) {
  const campaignId = job.campaign_id;
  log('info', `Refetch messages for campaign ${campaignId}`);

  try {
    await refetchEmptyDialogs(campaignId, db);
  } catch (err) {
    log('error', `Refetch failed for ${campaignId}: ${err instanceof Error ? err.message : String(err)}`);
  }

  await db.from('tg_outreach_jobs').update({
    status: 'completed',
    finished_at: new Date().toISOString(),
  }).eq('id', job.id);
}

async function pollOnce(): Promise<boolean> {
  const job = await claimJob();
  if (!job) return false;

  log('info', `Claimed job ${job.id}: ${job.action} for campaign ${job.campaign_id}`);

  try {
    switch (job.action) {
      case 'start':
        await handleStartJob(job);
        break;
      case 'stop':
        await handleStopJob(job);
        break;
      case 'restart':
        await handleRestartJob(job);
        break;
      case 'refetch_messages':
        await handleRefetchJob(job);
        break;
      default:
        log('warn', `Unknown action: ${job.action}`);
        await db.from('tg_outreach_jobs').update({
          status: 'failed',
          error_message: `Unknown action: ${job.action}`,
          finished_at: new Date().toISOString(),
        }).eq('id', job.id);
    }
  } catch (err) {
    log('error', `Job ${job.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    await db.from('tg_outreach_jobs').update({
      status: 'failed',
      error_message: err instanceof Error ? err.message : String(err),
      finished_at: new Date().toISOString(),
    }).eq('id', job.id);
  }

  return true;
}

async function resumeRunningCampaigns() {
  const { data: running } = await db
    .from('tg_outreach_campaigns')
    .select('id, user_id')
    .in('status', ['running', 'paused']);

  if (!running?.length) return;

  log('info', `Found ${running.length} campaigns with status running/paused, scheduling auto-resume`);
  for (const campaign of running) {
    const { data: existingJob } = await db
      .from('tg_outreach_jobs')
      .select('id')
      .eq('campaign_id', campaign.id)
      .in('status', ['pending', 'running'])
      .maybeSingle();

    if (!existingJob) {
      await db.from('tg_outreach_jobs').insert({
        campaign_id: campaign.id,
        user_id: campaign.user_id ?? '00000000-0000-0000-0000-000000000000',
        action: 'start',
        status: 'pending',
      });
      log('info', `Queued auto-resume start job for campaign ${campaign.id}`);
    }
  }

  // Обновляем paused → running, т.к. start job уже в очереди
  await db
    .from('tg_outreach_campaigns')
    .update({ status: 'running', updated_at: new Date().toISOString() })
    .eq('status', 'paused');
}

async function main() {
  log('info', 'TG Outreach worker starting...');
  await resetStuckJobs();
  await resumeRunningCampaigns();

  await pollLoop({
    log,
    pollIntervalMs: POLL_INTERVAL_MS,
    shouldStop,
    pollOnce,
    realtimeTables: ['tg_outreach_jobs'],
  });

  log('info', 'Waiting for running campaigns to finish...');
  const promises = Array.from(runningCampaigns.values()).map(r => {
    r.stop();
    return r.promise;
  });
  await Promise.all(promises);

  log('info', 'TG Outreach worker stopped');
  process.exit(0);
}

void main();

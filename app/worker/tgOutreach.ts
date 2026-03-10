import { createWorkerLogger, requireSupabaseAdmin, setupGracefulShutdown, sleep, pollLoop } from './_shared';
import { runCampaignLoop } from '@/lib/tgOutreach/campaignLoop';

const WORKER_ID = `tg-outreach-${process.pid}`;
const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS) || 5000;
const MAX_CONCURRENCY = 5;

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
    log('info', `Resetting ${data.length} stuck running jobs to failed`);
    await db
      .from('tg_outreach_jobs')
      .update({ status: 'failed', error_message: 'Worker restarted', finished_at: new Date().toISOString() })
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
    log('warning', `Campaign ${campaignId} already running, skipping start`);
    await db.from('tg_outreach_jobs').update({ status: 'completed', finished_at: new Date().toISOString() }).eq('id', job.id);
    return;
  }

  let stopRequested = false;
  const stopFn = () => { stopRequested = true; };

  const promise = runCampaignLoop(campaignId, db, () => shouldStop() || stopRequested)
    .then(() => {
      log('info', `Campaign ${campaignId} loop finished`);
    })
    .catch((err) => {
      log('error', `Campaign ${campaignId} loop error: ${err instanceof Error ? err.message : String(err)}`);
      void db.from('tg_outreach_campaigns').update({ status: 'error', updated_at: new Date().toISOString() }).eq('id', campaignId);
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
      default:
        log('warning', `Unknown action: ${job.action}`);
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

async function main() {
  log('info', 'TG Outreach worker starting...');
  await resetStuckJobs();

  await pollLoop({
    log,
    pollIntervalMs: POLL_INTERVAL_MS,
    shouldStop,
    pollOnce,
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

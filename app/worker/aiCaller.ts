import { createWorkerLogger, requireSupabaseAdmin, setupGracefulShutdown, pollLoop } from './_shared';
import { runCampaignLoop, resetStuckContacts } from '@/lib/ai-caller/campaignLoop';

const WORKER_ID = `ai-caller-${process.pid}`;
const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS) || 5000;
const MAX_CONCURRENCY = Number(process.env.AI_CALLER_MAX_CONCURRENCY ?? '3');

const log = createWorkerLogger(WORKER_ID);
const db = requireSupabaseAdmin(log);
const shouldStop = setupGracefulShutdown(log);

const runningCampaigns = new Map<string, { stop: () => void; promise: Promise<void> }>();

async function resetStuckJobs() {
  const { data } = await db
    .from('ai_caller_jobs')
    .select('id')
    .eq('status', 'running');

  if (data?.length) {
    log('info', `Resetting ${data.length} stuck running jobs to pending`);
    await db
      .from('ai_caller_jobs')
      .update({ status: 'pending', error_message: null, started_at: null, finished_at: null })
      .eq('status', 'running');
  }
}

async function claimJob(): Promise<{ id: string; campaign_id: string; action: string } | null> {
  const { data: pending } = await db
    .from('ai_caller_jobs')
    .select('id, campaign_id, action')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!pending) return null;

  const { data: claimed } = await db
    .from('ai_caller_jobs')
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
    await db.from('ai_caller_jobs').update({ status: 'completed', finished_at: new Date().toISOString() }).eq('id', job.id);
    return;
  }

  let stopRequested = false;
  const stopFn = () => { stopRequested = true; };

  const campaignLog = (level: 'info' | 'warn' | 'error', msg: string) => {
    log(level, `[campaign:${campaignId.slice(0, 8)}] ${msg}`);
  };

  const promise = runCampaignLoop(campaignId, db, () => shouldStop() || stopRequested, campaignLog)
    .then(() => {
      log('info', `Campaign ${campaignId} loop finished`);
    })
    .catch((err) => {
      log('error', `Campaign ${campaignId} loop error: ${err instanceof Error ? err.message : String(err)}`);
      void db.from('ai_campaigns').update({ status: 'paused', updated_at: new Date().toISOString() }).eq('id', campaignId);
    })
    .finally(() => {
      runningCampaigns.delete(campaignId);
      void db.from('ai_caller_jobs').update({ status: 'completed', finished_at: new Date().toISOString() }).eq('id', job.id);
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
    await db.from('ai_campaigns').update({ status: 'paused', updated_at: new Date().toISOString() }).eq('id', campaignId);
  }

  await db.from('ai_caller_jobs').update({ status: 'completed', finished_at: new Date().toISOString() }).eq('id', job.id);
}

async function pollOnce(): Promise<boolean> {
  if (runningCampaigns.size >= MAX_CONCURRENCY) {
    log(
      'info',
      `Max concurrent AI-caller campaigns reached (${runningCampaigns.size}/${MAX_CONCURRENCY}), waiting for free slot`,
    );
    return false;
  }

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
      default:
        log('warn', `Unknown action: ${job.action}`);
        await db.from('ai_caller_jobs').update({
          status: 'failed',
          error_message: `Unknown action: ${job.action}`,
          finished_at: new Date().toISOString(),
        }).eq('id', job.id);
    }
  } catch (err) {
    log('error', `Job ${job.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    await db.from('ai_caller_jobs').update({
      status: 'failed',
      error_message: err instanceof Error ? err.message : String(err),
      finished_at: new Date().toISOString(),
    }).eq('id', job.id);
  }

  return true;
}

async function resumeRunningCampaigns() {
  const { data: running } = await db
    .from('ai_campaigns')
    .select('id')
    .eq('status', 'running');

  if (!running?.length) return;

  log('info', `Found ${running.length} campaigns with status=running, scheduling start jobs`);
  for (const campaign of running) {
    await resetStuckContacts(db, campaign.id, log);

    const { data: existingJob } = await db
      .from('ai_caller_jobs')
      .select('id')
      .eq('campaign_id', campaign.id)
      .in('status', ['pending', 'running'])
      .maybeSingle();

    if (!existingJob) {
      await db.from('ai_caller_jobs').insert({
        campaign_id: campaign.id,
        user_id: '00000000-0000-0000-0000-000000000000',
        action: 'start',
        status: 'pending',
      });
      log('info', `Queued auto-resume start job for campaign ${campaign.id}`);
    }
  }
}

async function main() {
  log('info', 'AI Caller worker starting...');
  await resetStuckJobs();
  await resumeRunningCampaigns();

  await pollLoop({
    log,
    pollIntervalMs: POLL_INTERVAL_MS,
    shouldStop,
    pollOnce,
    realtimeTables: ['ai_caller_jobs'],
  });

  log('info', 'Waiting for running campaigns to finish...');
  const promises = Array.from(runningCampaigns.values()).map((r) => {
    r.stop();
    return r.promise;
  });
  await Promise.all(promises);

  log('info', 'AI Caller worker stopped');
  process.exit(0);
}

void main();

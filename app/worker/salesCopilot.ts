import { createWorkerLogger, requireSupabaseAdmin, setupGracefulShutdown, pollLoop } from './_shared';
import { runCopilotLoop } from '@/lib/salesCopilot/copilotLoop';

const WORKER_ID = `sales-copilot-${process.pid}`;
const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS) || 5000;

const log = createWorkerLogger(WORKER_ID);
const db = requireSupabaseAdmin(log);
const shouldStop = setupGracefulShutdown(log);

const runningConfigs = new Map<string, { stop: () => void; promise: Promise<void> }>();

async function resetStuckJobs() {
  const { data } = await db
    .from('sales_copilot_jobs')
    .select('id')
    .eq('status', 'running');

  if (data?.length) {
    log('info', `Resetting ${data.length} stuck running jobs to failed`);
    await db
      .from('sales_copilot_jobs')
      .update({ status: 'failed', error_message: 'Worker restarted', finished_at: new Date().toISOString() })
      .eq('status', 'running');
  }
}

async function claimJob(): Promise<{ id: string; config_id: string; action: string } | null> {
  const { data: pending } = await db
    .from('sales_copilot_jobs')
    .select('id, config_id, action')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!pending) return null;

  const { data: claimed } = await db
    .from('sales_copilot_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id, config_id, action')
    .maybeSingle();

  return claimed ?? null;
}

async function handleStartJob(job: { id: string; config_id: string }) {
  const configId = job.config_id;

  if (runningConfigs.has(configId)) {
    log('info', `Config ${configId} already running, skipping start`);
    await db.from('sales_copilot_jobs').update({ status: 'completed', finished_at: new Date().toISOString() }).eq('id', job.id);
    return;
  }

  let stopRequested = false;
  const stopFn = () => { stopRequested = true; };

  const promise = runCopilotLoop(configId, db, () => shouldStop() || stopRequested)
    .then(() => {
      log('info', `Copilot ${configId} loop finished`);
    })
    .catch((err) => {
      log('error', `Copilot ${configId} loop error: ${err instanceof Error ? err.message : String(err)}`);
      void db.from('sales_copilot_configs').update({ is_enabled: false }).eq('id', configId);
    })
    .finally(() => {
      runningConfigs.delete(configId);
      void db.from('sales_copilot_jobs').update({ status: 'completed', finished_at: new Date().toISOString() }).eq('id', job.id);
    });

  runningConfigs.set(configId, { stop: stopFn, promise });
  log('info', `Started copilot ${configId}`);
}

async function handleStopJob(job: { id: string; config_id: string }) {
  const configId = job.config_id;
  const running = runningConfigs.get(configId);

  if (running) {
    running.stop();
    log('info', `Signaled stop for copilot ${configId}`);
    await running.promise;
  } else {
    await db.from('sales_copilot_configs').update({ is_enabled: false, updated_at: new Date().toISOString() }).eq('id', configId);
  }

  await db.from('sales_copilot_jobs').update({ status: 'completed', finished_at: new Date().toISOString() }).eq('id', job.id);
}

async function pollOnce(): Promise<boolean> {
  const job = await claimJob();
  if (!job) return false;

  log('info', `Claimed job ${job.id}: ${job.action} for config ${job.config_id}`);

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
        await db.from('sales_copilot_jobs').update({
          status: 'failed',
          error_message: `Unknown action: ${job.action}`,
          finished_at: new Date().toISOString(),
        }).eq('id', job.id);
    }
  } catch (err) {
    log('error', `Job ${job.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    await db.from('sales_copilot_jobs').update({
      status: 'failed',
      error_message: err instanceof Error ? err.message : String(err),
      finished_at: new Date().toISOString(),
    }).eq('id', job.id);
  }

  return true;
}

async function resumeEnabledConfigs() {
  const { data: configs } = await db
    .from('sales_copilot_configs')
    .select('id, user_id')
    .eq('is_enabled', true);

  if (!configs?.length) return;

  log('info', `Resuming ${configs.length} enabled config(s) after restart`);
  for (const cfg of configs) {
    const { error } = await db
      .from('sales_copilot_jobs')
      .insert({ config_id: cfg.id, user_id: cfg.user_id, action: 'start' });
    if (error) {
      log('error', `Failed to create resume job for ${cfg.id}: ${error.message}`);
    }
  }
}

async function main() {
  log('info', 'Sales Copilot worker starting...');
  await resetStuckJobs();
  await resumeEnabledConfigs();

  await pollLoop({
    log,
    pollIntervalMs: POLL_INTERVAL_MS,
    shouldStop,
    pollOnce,
  });

  log('info', 'Waiting for running copilots to finish...');
  const promises = Array.from(runningConfigs.values()).map(r => {
    r.stop();
    return r.promise;
  });
  await Promise.all(promises);

  log('info', 'Sales Copilot worker stopped');
  process.exit(0);
}

void main();

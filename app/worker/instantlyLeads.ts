import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { pollAndQualifyReplies, drainWebhookQueue } from '@/lib/instantly/leadQualificationWorker';
import { createWorkerLogger, setupGracefulShutdown } from './_shared';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '30000');
const DRAIN_INTERVAL_MS = Number(process.env.INSTANTLY_WEBHOOK_DRAIN_INTERVAL_MS ?? '7000');
const DRAIN_ENABLED = ['1', 'true', 'yes', 'on'].includes(
  (process.env.INSTANTLY_WEBHOOK_DRAIN_ENABLED ?? '').toLowerCase(),
);
const WORKER_ID = `instantly-leads-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Поллинг — система записи / reconciliation-бэкап. Поведение не менялось.
async function pollLoop(shouldStop: () => boolean): Promise<void> {
  while (!shouldStop()) {
    try {
      const count = await pollAndQualifyReplies();
      if (count > 0) log('info', `Qualified ${count} reply(s)`);
    } catch (err) {
      log('error', 'Poll cycle failed', err);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

// Real-time путь — разгребает reply-события из очереди вебхуков (за флагом).
// Делит ту же qualifyOneReply + UNIQUE-дедуп instantly_email_id с поллингом,
// поэтому двойных вставок/алертов быть не может.
async function drainLoop(shouldStop: () => boolean): Promise<void> {
  while (!shouldStop()) {
    try {
      const n = await drainWebhookQueue();
      if (n > 0) log('info', `Drained ${n} reply(s) from webhook queue`);
    } catch (err) {
      log('error', 'Drain cycle failed', err);
    }
    await sleep(DRAIN_INTERVAL_MS);
  }
}

async function main(): Promise<void> {
  log('info', `Starting Instantly lead qualification worker (pid=${process.pid})`);

  if (!supabaseInstantly) {
    log('error', 'INSTANTLY_SUPABASE_URL / INSTANTLY_SUPABASE_SERVICE_ROLE_KEY not set — cannot start');
    process.exit(1);
  }

  const shouldStop = setupGracefulShutdown(log);

  const loops = [pollLoop(shouldStop)];
  if (DRAIN_ENABLED) {
    log('info', `Real-time webhook drain ENABLED (every ${DRAIN_INTERVAL_MS}ms)`);
    loops.push(drainLoop(shouldStop));
  }
  await Promise.all(loops);

  log('info', 'Worker stopped');
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});

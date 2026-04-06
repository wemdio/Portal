import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { pollAndQualifyReplies } from '@/lib/instantly/leadQualificationWorker';
import { createWorkerLogger, setupGracefulShutdown } from './_shared';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '30000');
const WORKER_ID = `instantly-leads-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  log('info', `Starting Instantly lead qualification worker (pid=${process.pid})`);

  if (!supabaseInstantly) {
    log('error', 'INSTANTLY_SUPABASE_URL / INSTANTLY_SUPABASE_SERVICE_ROLE_KEY not set — cannot start');
    process.exit(1);
  }

  const shouldStop = setupGracefulShutdown(log);

  while (!shouldStop()) {
    try {
      const count = await pollAndQualifyReplies();
      if (count > 0) {
        log('info', `Qualified ${count} reply(s)`);
      }
    } catch (err) {
      log('error', 'Poll cycle failed', err);
    }
    await sleep(POLL_INTERVAL_MS);
  }

  log('info', 'Worker stopped');
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});

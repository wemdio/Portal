import { supabaseAdmin } from '@/lib/supabaseAdmin';

export type WorkerLogger = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

export function createWorkerLogger(workerId: string): WorkerLogger {
  return (level, msg, extra) => {
    const line = `[worker][${workerId}][${level.toUpperCase()}] ${msg}`;
    if (extra !== undefined) console[level](line, extra);
    else console[level](line);
  };
}

export function requireSupabaseAdmin(log: WorkerLogger) {
  if (!supabaseAdmin) {
    log('error', 'SUPABASE_SERVICE_ROLE_KEY is not set — worker cannot start');
    process.exit(1);
  }
  return supabaseAdmin;
}

export function setupGracefulShutdown(log: WorkerLogger) {
  let shuttingDown = false;
  const onSignal = (sig: string) => {
    log('info', `Received ${sig}, stopping after current job completes...`);
    shuttingDown = true;
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
  return () => shuttingDown;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollLoop(opts: {
  log: WorkerLogger;
  pollIntervalMs: number;
  shouldStop: () => boolean;
  pollOnce: () => Promise<boolean>;
}) {
  const { log, pollIntervalMs, shouldStop, pollOnce } = opts;
  log('info', 'Polling loop started');

  while (!shouldStop()) {
    try {
      const found = await pollOnce();
      if (!found) {
        await sleep(pollIntervalMs);
      }
    } catch (err) {
      log('error', 'Unexpected error in poll loop', err);
      await sleep(pollIntervalMs);
    }
  }

  log('info', 'Poll loop exited (shutting down)');
}

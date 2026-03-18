import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { RealtimeChannel } from '@supabase/supabase-js';

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

const FALLBACK_POLL_MS = 30_000;

/**
 * Creates a promise that resolves when either:
 * - a Realtime notification arrives (immediate wake)
 * - the fallback timeout fires
 * - an external wake signal is called
 */
function createWaiter(timeoutMs: number) {
  let resolve: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  const timer = setTimeout(() => resolve!(), timeoutMs);
  const wake = () => { clearTimeout(timer); resolve!(); };
  return { promise, wake, cleanup: () => clearTimeout(timer) };
}

export async function pollLoop(opts: {
  log: WorkerLogger;
  pollIntervalMs: number;
  shouldStop: () => boolean;
  pollOnce: () => Promise<boolean>;
  realtimeTables?: string[];
}) {
  const { log, pollIntervalMs, shouldStop, pollOnce, realtimeTables } = opts;
  const effectiveFallback = Math.max(pollIntervalMs, FALLBACK_POLL_MS);

  let channel: RealtimeChannel | null = null;
  let currentWaiter: ReturnType<typeof createWaiter> | null = null;

  if (supabaseAdmin && realtimeTables?.length) {
    const channelName = `worker_jobs_${realtimeTables.join('_')}`;
    channel = supabaseAdmin.channel(channelName);

    for (const table of realtimeTables) {
      channel = channel.on(
        'postgres_changes' as 'postgres_changes',
        { event: 'INSERT', schema: 'public', table, filter: 'status=eq.pending' },
        () => { currentWaiter?.wake(); },
      );
      channel = channel.on(
        'postgres_changes' as 'postgres_changes',
        { event: 'UPDATE', schema: 'public', table, filter: 'status=eq.pending' },
        () => { currentWaiter?.wake(); },
      );
    }

    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        log('info', `Realtime subscribed to: ${realtimeTables.join(', ')}`);
      } else if (status === 'CHANNEL_ERROR') {
        log('warn', `Realtime channel error — falling back to ${effectiveFallback}ms polling`);
      }
    });
  }

  log('info', realtimeTables?.length
    ? `Poll loop started (realtime + ${effectiveFallback}ms fallback)`
    : `Poll loop started (${pollIntervalMs}ms interval)`);

  while (!shouldStop()) {
    try {
      const found = await pollOnce();
      if (!found) {
        if (channel) {
          currentWaiter = createWaiter(effectiveFallback);
          await currentWaiter.promise;
          currentWaiter = null;
        } else {
          await sleep(pollIntervalMs);
        }
      }
    } catch (err) {
      log('error', 'Unexpected error in poll loop', err);
      await sleep(pollIntervalMs);
    }
  }

  if (channel) {
    currentWaiter?.cleanup();
    await supabaseAdmin!.removeChannel(channel);
    log('info', 'Realtime channel removed');
  }

  log('info', 'Poll loop exited (shutting down)');
}

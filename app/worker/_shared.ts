import fs from 'node:fs';
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

/**
 * Пишет monotonic timestamp в heartbeat-файл. Внешний docker healthcheck
 * читает mtime этого файла и флипает контейнер в unhealthy, если он не
 * обновлялся дольше порога — autoheal перезапускает.
 *
 * Кладём на отдельный setInterval (см. `startWorkerHeartbeat` ниже), а не
 * внутрь основного pollLoop: если основной цикл застрял (deadlock,
 * бесконечный retry, hung fetch к БД без abort), setInterval callback
 * не выполнится, файл протухнет, healthcheck его увидит.
 *
 * ВАЖНО: работает только пока жив node.js event loop. Если весь event
 * loop замер (микрозадачная гонка / hung syscall) — heartbeat не тикает,
 * и это как раз тот сигнал, который нам нужен для рестарта.
 */
export function writeHeartbeat(path: string): void {
  try {
    fs.writeFileSync(path, Date.now().toString());
  } catch {
    /* if /tmp is broken we can't do anything useful here */
  }
}

/**
 * Заводит независимый heartbeat-тикер для воркера. Возвращает id таймера,
 * чтобы вызывающая сторона могла остановить его при graceful shutdown.
 *
 * Прецедент: `worker/tgOutreach.ts` + `_recvLoop` hang'и на 35 часов до
 * добавления такого heartbeat (см. коммент в tgOutreach.ts). Инцидент
 * 27.07.2026 повторил тот же паттерн уже на yandexmaps-воркере: node.js
 * процесс жив (Up), но event loop мёртв (CPU 0.03%, 5+ часов молчания),
 * задачи не подхватываются. Healthcheck на heartbeat + autoheal ловит это
 * за 5 минут вместо 5+ часов до ручного `docker restart`.
 *
 * Дефолт интервал — 30с; healthcheck обычно ставится с порогом 300с
 * (10× запас), чтобы GC-паузы и мимолётные скачки не флипали unhealthy.
 */
export function startWorkerHeartbeat(
  filePath: string,
  intervalMs = 30_000,
): NodeJS.Timeout {
  writeHeartbeat(filePath);
  const timer = setInterval(() => writeHeartbeat(filePath), intervalMs);
  // Не блокируем graceful shutdown таймером.
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
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

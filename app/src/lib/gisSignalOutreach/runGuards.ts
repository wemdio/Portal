/**
 * Защитные механизмы дневного прогона gisSignalOutreach (инцидент 12.08.2026:
 * прогон на 2000 кандидатов молча завис на 7 часов после фазы проверки сайтов —
 * мёртвое ожидание promise без логов, запросов в БД, сокетов и CPU; день потерян,
 * процесс убит вручную).
 *
 * Здесь — два независимых guard'а:
 *
 * 1. createStallWatchdog — сторожевой таймер тишины. Runner сбрасывает его
 *    каждым heartbeat/этапным логом (и каждым завершённым кандидатом пула);
 *    тишина дольше таймаута → onStall (runner там пишет failed в gis_signal_runs
 *    и делает process.exit(2)).
 *
 *    Таймер НАМЕРЕННО НЕ unref'ится: если остальной event loop опустел
 *    (ровно сценарий мёртвого promise — ни сокетов, ни таймеров), watchdog
 *    остаётся единственным handle'ом, который держит процесс, и гарантированно
 *    срабатывает. С unref node просто вышел бы с кодом 0 по первому простою —
 *    крон решил бы «прогон успешен», и день снова был бы потерян молча.
 *
 * 2. guardAgainstConcurrentRun — overlap-защита + stale-reaper, вызывается из
 *    cron-обёртки ДО запуска runner'а:
 *      - есть status='running' младше STALE_RUNNING_THRESHOLD_MS (5ч) →
 *        параллельный прогон идёт, выходим (пропуск, второй не запускаем);
 *      - есть только running старше 5ч → это труп зависшего прогона: помечаем
 *        failed ('stale reaped at cron start') и продолжаем;
 *      - чтение упало → fail-open (продолжаем): следующий же insert run-строки
 *        в runner'е всё равно покажет состояние БД.
 */

import type { supabaseAdmin } from '@/lib/supabaseAdmin';

/** Тип админ-клиента main-БД (тот, что возвращает @/lib/supabaseAdmin). */
export type GisSignalAdminDb = NonNullable<typeof supabaseAdmin>;

/** «Running»-строка протухает через 5 часов — дневной прогон здоровым столько не живёт. */
export const STALE_RUNNING_THRESHOLD_MS = 5 * 60 * 60 * 1000;

export interface StallWatchdog {
  /** Сброс отсчёта: вызывать на каждом heartbeat/этапном логе/единице прогресса. */
  touch: () => void;
  /** Полная остановка (нормальное завершение runner'а). */
  stop: () => void;
}

export function createStallWatchdog(timeoutMs: number, onStall: () => void): StallWatchdog {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const touch = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null; // one-shot: после срабатывания не перевзводимся сами
      onStall();
    }, timeoutMs);
  };
  const stop = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  touch(); // отсчёт начинается сразу при создании
  return { touch, stop };
}

export interface RunningRunRow {
  id: string | number;
  started_at: string;
}

/**
 * Чистая функция решения: running-строки → свежие (младше staleMs) и протухшие.
 * Непарсящийся started_at считаем СВЕЖИМ (непонятное не реапим и не игнорируем —
 * безопаснее пропустить прогон). Граница: age >= staleMs → stale.
 */
export function partitionRunningRuns(
  rows: RunningRunRow[],
  nowMs: number,
  staleMs: number = STALE_RUNNING_THRESHOLD_MS,
): { fresh: RunningRunRow[]; stale: RunningRunRow[] } {
  const fresh: RunningRunRow[] = [];
  const stale: RunningRunRow[] = [];
  for (const row of rows) {
    const age = nowMs - Date.parse(row.started_at);
    if (Number.isFinite(age) && age >= staleMs) stale.push(row);
    else fresh.push(row);
  }
  return { fresh, stale };
}

export interface ConcurrentRunGuardResult {
  /** false → активный прогон уже идёт, cron обязан выйти без запуска. */
  proceed: boolean;
  /** Сколько протухших running-строк помечено failed на этом запуске. */
  reapedStale: number;
}

export async function guardAgainstConcurrentRun(
  db: GisSignalAdminDb,
  log: (msg: string) => void,
  opts: { now?: Date; staleMs?: number } = {},
): Promise<ConcurrentRunGuardResult> {
  const now = opts.now ?? new Date();
  const staleMs = opts.staleMs ?? STALE_RUNNING_THRESHOLD_MS;

  const { data, error } = await db
    .from('gis_signal_runs')
    .select('id, started_at')
    .eq('status', 'running');
  if (error) {
    log(`overlap-check: не удалось прочитать gis_signal_runs (${error.message}) — продолжаем без защиты`);
    return { proceed: true, reapedStale: 0 };
  }

  const { fresh, stale } = partitionRunningRuns(
    (data ?? []) as RunningRunRow[],
    now.getTime(),
    staleMs,
  );

  if (fresh.length > 0) {
    log(
      `overlap-check: уже есть активный прогон (id=${fresh[0].id}, started_at=${fresh[0].started_at}) — ` +
      'пропуск, второй прогон не запускаем',
    );
    return { proceed: false, reapedStale: 0 };
  }

  for (const row of stale) {
    const { error: updErr } = await db
      .from('gis_signal_runs')
      .update({
        status: 'failed',
        error: 'stale reaped at cron start',
        finished_at: now.toISOString(),
      })
      .eq('id', row.id);
    log(
      updErr
        ? `stale-reaper: не смог пометить run ${row.id} failed (${updErr.message}) — продолжаем`
        : `stale-reaper: run ${row.id} висел running с ${row.started_at} (>5ч) — помечен failed ('stale reaped at cron start')`,
    );
  }
  return { proceed: true, reapedStale: stale.length };
}

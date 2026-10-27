import { Pool, type PoolClient } from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import { assertTwoGisDatasetTarget } from '@/lib/twoGis/importGuard';

/**
 * Чтение снимка 2ГИС для VE2 (план docs/reports/2026-10-26-2gis-ve2-plan.md, R3).
 * Импортирует только воркер VE2: свой пользователь twogis_ve2 (лимит 2 соединения
 * на роль) и свой пул, общие пулы портала (lib/twoGisDataset.ts) не трогаем —
 * иначе VE2 занял бы соединения OutreachOS и парсера.
 *
 * Пул — одно соединение на процесс (воркер VE2 — один процесс; при деплое старый
 * и новый контейнер вместе укладываются в 2), простаивающее закрывается через 2 с.
 * Очередь — свой семафор: ожидание своей очереди не считается сбоем базы, а
 * 3 с на подключение меряют только настоящее подключение. Каждое чтение — одна
 * короткая read-only транзакция. Три сбоя базы подряд — пауза 10 мин. Смена
 * снимка — ответ живой базы: в статусе считается как ошибка (с третьей подряд —
 * серия для health-check), но паузу не ставит, серию сбоев для паузы обнуляет, а
 * соединение после отката возвращается в пул. Состояние для health-check пишется
 * в ve_twogis_source_status уже после возврата соединения.
 */
export const VE_TWO_GIS_APPLICATION_NAME = 'portal-ve2-2gis';
export const VE_TWO_GIS_ENV = 'TWOGIS_VE2_DATABASE_URL';
const PAUSE_AFTER_ERRORS = 3;
const PAUSE_MS = 10 * 60_000;
const STATUS_REPEAT_MS = 60_000;
const QUEUE_WAIT_MS = 45_000;

/** Виды, которые пишутся в ve_twogis_source_status (check constraint R2). */
export type VeTwoGisErrorKind = 'connect' | 'role_limit' | 'timeout' | 'snapshot' | 'other';

/**
 * Чтение 2ГИС сейчас невозможно. Для задачи-близнеца это отсрочка, не failed;
 * kind 'snapshot' — снимок сменился (близнец unavailable), 'busy' — очередь
 * процесса не дошла (не сбой базы), 'paused' — пауза после сбоев.
 */
export class VeTwoGisUnavailableError extends Error {
  constructor(readonly kind: VeTwoGisErrorKind | 'paused' | 'not_configured' | 'busy', message: string,
    readonly pausedUntil: Date | null = null) {
    super(message);
    this.name = 'VeTwoGisUnavailableError';
  }
}

/** Снимок, на котором проверена сборка, больше не текущий (шаг страницы 2). */
export class VeTwoGisSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VeTwoGisSnapshotError';
  }
}

export function classifyVeTwoGisError(error: unknown): VeTwoGisErrorKind {
  if (error instanceof VeTwoGisSnapshotError) return 'snapshot';
  if (error instanceof VeTwoGisUnavailableError && error.kind === 'not_configured') return 'connect';
  const value = error as { code?: unknown; message?: unknown } | null;
  const code = typeof value?.code === 'string' ? value.code : '';
  const message = typeof value?.message === 'string' ? value.message : '';
  if (code === '53300') return /for role/i.test(message) ? 'role_limit' : 'connect';
  if (code === '57014' || code === '55P03' || code === '25P03'
    || /timeout exceeded when trying to connect|connection timeout|Query read timeout|timeout expired/i.test(message)) return 'timeout';
  if (/^(08|28|3D|57P0[123])/.test(code) || ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'EAI_AGAIN', 'EPIPE'].includes(code)
    || /Connection terminated|connect ECONN|getaddrinfo|not queryable/i.test(message)) return 'connect';
  // 25006 (запись в read-only) — ошибка кода, не базы: остаётся 'other'.
  return 'other';
}

interface SourceState {
  pool: Pool | null;
  url: string | null;
  verified: boolean;
  /** Все ошибки подряд, включая смену снимка: для статуса и health-check. */
  consecutiveErrors: number;
  /** Сбои базы подряд (без смены снимка): только они ставят паузу. */
  pauseStreak: number;
  errorSince: Date | null;
  pausedUntil: Date | null;
  pauseSetAt: number;
  lastErrorKind: VeTwoGisErrorKind | null;
  lastErrorAt: Date | null;
  statusSignature: string | null;
  statusWrittenAt: number;
  statusChain: Promise<void>;
  closing: boolean;
}

const state: SourceState = {
  pool: null, url: null, verified: false, consecutiveErrors: 0, pauseStreak: 0, errorSince: null, pausedUntil: null, pauseSetAt: 0,
  lastErrorKind: null, lastErrorAt: null, statusSignature: null, statusWrittenAt: 0, statusChain: Promise.resolve(),
  closing: false,
};

/** Одна очередь на процесс: пул никогда не ждёт сам, ожидание ограничено QUEUE_WAIT_MS. */
const waiters: Array<() => void> = [];
let busy = false;

function acquireTurn(timeoutMs: number): Promise<() => void> {
  const release = () => {
    const next = waiters.shift();
    if (next) next(); else busy = false;
  };
  if (!busy) {
    busy = true;
    return Promise.resolve(release);
  }
  return new Promise((resolve, reject) => {
    const grant = () => {
      clearTimeout(timer);
      resolve(release);
    };
    const timer = setTimeout(() => {
      const index = waiters.indexOf(grant);
      if (index >= 0) waiters.splice(index, 1);
      reject(new VeTwoGisUnavailableError('busy', '2ГИС: очередь процесса не дошла'));
    }, timeoutMs);
    waiters.push(grant);
  });
}

export const veTwoGisConfigured = (env: Record<string, string | undefined> = process.env) => !!env[VE_TWO_GIS_ENV];

function sourcePool(url: string): Pool {
  if (state.closing) throw new VeTwoGisUnavailableError('busy', '2ГИС: воркер останавливается');
  if (state.pool && state.url === url) return state.pool;
  if (state.pool) void state.pool.end().catch(() => undefined);
  const pool = new Pool({
    connectionString: url,
    max: 1,
    idleTimeoutMillis: 2_000,
    connectionTimeoutMillis: 3_000,
    statement_timeout: 10_000,
    // Сервер может не ответить вовсе (замерший контейнер, полуоткрытый сокет).
    query_timeout: 12_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    application_name: VE_TWO_GIS_APPLICATION_NAME,
  });
  pool.on('error', (error) => console.error(`[${VE_TWO_GIS_APPLICATION_NAME}] idle pool error:`, error.message));
  state.pool = pool;
  state.url = url;
  state.verified = false;
  return pool;
}

/**
 * Состояние для health-check: сразу при смене, повтор того же — не чаще раза в
 * минуту (и во время паузы: строка старше 15 мин для health-check — «норма»).
 * Записи идут по одной и пишут то, что верно на момент записи. Сбой записи не
 * мешает чтению.
 */
function recordStatus(db: SupabaseClient | undefined, clock: () => Date): Promise<void> {
  if (!db) return Promise.resolve();
  state.statusChain = state.statusChain.then(async () => {
    const now = clock().getTime();
    const paused = !!state.pausedUntil && state.pausedUntil.getTime() > now;
    // Переход в серию (третья ошибка подряд) — тоже смена: без паузы пачка ошибок снимка
    // иначе записалась бы один раз с n=1, и health-check её не увидел бы.
    const signature = state.consecutiveErrors === 0 ? 'ok' : `${state.lastErrorKind}:${paused ? 'paused' : 'error'}:`
      + (state.consecutiveErrors >= PAUSE_AFTER_ERRORS ? 'series' : 'start');
    if (signature === state.statusSignature && now - state.statusWrittenAt < STATUS_REPEAT_MS) return;
    const patch = state.consecutiveErrors === 0
      ? { consecutive_errors: 0, error_since: null, paused_until: null }
      : { consecutive_errors: state.consecutiveErrors, error_since: state.errorSince!.toISOString(),
        paused_until: paused ? state.pausedUntil!.toISOString() : null, last_error_kind: state.lastErrorKind,
        last_error_at: state.lastErrorAt!.toISOString() };
    try {
      const { error } = await db.from('ve_twogis_source_status').update(patch).eq('market', 'ru');
      if (error) throw new Error(error.message);
      state.statusSignature = signature;
      state.statusWrittenAt = now;
    } catch (error) {
      console.error(`[${VE_TWO_GIS_APPLICATION_NAME}] status write failed:`, error instanceof Error ? error.message : String(error));
    }
  });
  return state.statusChain;
}

function noteFailure(error: unknown, now: Date): VeTwoGisUnavailableError {
  const kind = classifyVeTwoGisError(error);
  // Смена снимка и сбои базы — разные серии статуса: переход между ними начинает счёт заново.
  if (state.consecutiveErrors > 0 && (kind === 'snapshot') !== (state.lastErrorKind === 'snapshot')) {
    state.consecutiveErrors = 0;
    state.errorSince = null;
  }
  state.consecutiveErrors += 1;
  state.errorSince ??= now;
  state.lastErrorKind = kind;
  state.lastErrorAt = now;
  // Смена снимка — ответ базы: паузу не ставит и серию сбоев обнуляет, так что каждый
  // близнец на своём первом чтении получает 'snapshot' и уходит, а не 'paused'.
  state.pauseStreak = kind === 'snapshot' ? 0 : state.pauseStreak + 1;
  if (state.pauseStreak >= PAUSE_AFTER_ERRORS) {
    state.pausedUntil = new Date(now.getTime() + PAUSE_MS);
    state.pauseSetAt = now.getTime();
  }
  const reason = error instanceof Error ? error.message : String(error);
  const reported = error instanceof VeTwoGisUnavailableError && error.kind === 'not_configured' ? 'not_configured' : kind;
  return new VeTwoGisUnavailableError(reported, `2ГИС: ${reported} (${reason.slice(0, 200)})`, state.pausedUntil);
}

function noteSuccess(started: Date): void {
  // Успех чтения, начатого до последней паузы, не снимает паузу от более новых сбоев.
  if (started.getTime() < state.pauseSetAt) return;
  state.consecutiveErrors = 0;
  state.pauseStreak = 0;
  state.errorSince = null;
  state.pausedUntil = null;
}

/**
 * Одна read-only транзакция в базе 2ГИС под twogis_ve2. Любой сбой —
 * VeTwoGisUnavailableError (вызывающий откладывает задачу); fn не должна
 * перехватывать ошибки запросов. Пауза после сбоев в базу не ходит.
 */
export async function withVeTwoGisReadOnly<T>(fn: (client: PoolClient) => Promise<T>,
  options: { db?: SupabaseClient; now?: () => Date; env?: Record<string, string | undefined>; queueWaitMs?: number } = {}): Promise<T> {
  const now = options.now ?? (() => new Date());
  const paused = () => {
    if (!state.pausedUntil || state.pausedUntil.getTime() <= now().getTime()) return null;
    void recordStatus(options.db, now);
    return new VeTwoGisUnavailableError('paused', `2ГИС: пауза после ошибок до ${state.pausedUntil.toISOString()}`, state.pausedUntil);
  };
  if (state.closing) throw new VeTwoGisUnavailableError('busy', '2ГИС: воркер останавливается');
  const pausedOnArrival = paused();
  if (pausedOnArrival) throw pausedOnArrival;
  const url = (options.env ?? process.env)[VE_TWO_GIS_ENV];
  if (!url) {
    const failure = noteFailure(new VeTwoGisUnavailableError('not_configured', `${VE_TWO_GIS_ENV} не задан`), now());
    void recordStatus(options.db, now);
    throw failure;
  }
  const releaseTurn = await acquireTurn(options.queueWaitMs ?? QUEUE_WAIT_MS);
  // Пока ждали очередь, могла начаться пауза или остановка: в базу тогда не ходим.
  const blocked = state.closing ? new VeTwoGisUnavailableError('busy', '2ГИС: воркер останавливается') : paused();
  if (blocked) {
    releaseTurn();
    throw blocked;
  }
  const started = now();
  let client: PoolClient | null = null;
  let broken: Error | undefined;
  const onClientError = (error: Error) => { broken ??= error; };
  let outcome: { ok: true; value: T } | { ok: false; error: VeTwoGisUnavailableError };
  try {
    const pool = sourcePool(url);
    client = await pool.connect();
    // Обрыв сокета во время запроса pg шлёт событием: без слушателя он уронил бы весь воркер.
    client.on('error', onClientError);
    if (!state.verified) {
      await assertTwoGisDatasetTarget({ query: async (sql, params) => ({ rows: (await client!.query(sql, params)).rows }) });
      state.verified = true;
    }
    await client.query('BEGIN READ ONLY');
    const value = await fn(client);
    await client.query('COMMIT');
    outcome = { ok: true, value };
  } catch (error) {
    if (error instanceof VeTwoGisSnapshotError && client && !broken) {
      // Смена снимка: запросы ответили, сокет цел — откатываем и возвращаем соединение
      // в пул. Не вышел откат — соединение уничтожается, как после любого сбоя.
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        broken ??= rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      }
    } else {
      // ROLLBACK не шлём: соединение после ошибки уничтожается, сервер откатит сам,
      // а на зависшем сокете ROLLBACK встал бы в очередь за запросом.
      broken ??= error instanceof Error ? error : new Error(String(error));
    }
    outcome = { ok: false, error: noteFailure(error, now()) };
  } finally {
    try {
      if (client) {
        client.removeListener('error', onClientError);
        // Соединение после сбоя (broken) не возвращаем в пул: оно могло остаться в странном
        // состоянии. Без broken — успех или откат после смены снимка.
        client.release(broken);
      }
    } finally {
      releaseTurn();
    }
  }
  if (outcome.ok) noteSuccess(started);
  // Запись состояния не задерживает результат чтения: она идёт своей очередью.
  void recordStatus(options.db, now);
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/** Закрыть пул при остановке воркера: новые и ждущие вызовы получают 'busy'. */
export async function closeVeTwoGisPool(): Promise<void> {
  state.closing = true;
  const pool = state.pool;
  state.pool = null;
  state.url = null;
  state.verified = false;
  if (pool) await pool.end().catch(() => undefined);
}

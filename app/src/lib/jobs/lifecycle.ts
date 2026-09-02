/**
 * Единый жизненный цикл фоновых задач.
 *
 * Одна библиотека вместо самописных claim/recover/resetStuck в каждом воркере.
 * Spec: docs/superpowers/specs/2026-09-02-job-lifecycle-design.md.
 *
 * Что делает:
 *  1. Захват. pending → running с новым run_token и арендой lease_until (CAS по
 *     status). Если pending нет — running с истёкшей (lt now) или обнулённой
 *     (null) арендой. Через PostgREST, без RPC: тот же паттерн, что годами
 *     работает в конструкторе баз.
 *  2. Продление. Пока run() идёт, независимый setInterval продлевает аренду с
 *     фильтром run_token. После markShuttingDown() продления молчат (инцидент
 *     11.08.2026: heartbeat затирал handoff).
 *  3. Чекпойнт. ctx.saveCheckpoint пишет checkpoint + продлевает аренду; false —
 *     строку перехватили, воркер обязан остановиться (мы ещё и abort'им signal).
 *  4. Остановка. shutdown(): markShuttingDown, abort всех run, lease_until=null
 *     своим задачам дважды с паузой в секунду (перебивает продление, ушедшее до
 *     сигнала), ждём run-промисы до shutdownGraceMs. Новая реплика подхватит
 *     задачу на первом опросе.
 *  5. Восстановления при старте НЕТ. Брошенная задача = истёкшая/обнулённая
 *     аренда. Поэтому механизм корректен при любом числе реплик.
 *
 * attempts считает потери аренды (crash/OOM/SIGKILL) и исключения в run().
 * Чистая передача при shutdown (lease_until=null) попыткой не считается —
 * иначе три деплоя подряд роняли бы трёхчасовую задачу.
 */

import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isShuttingDown, markShuttingDown } from '@/lib/workerShutdown';

export type JobLogger = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

export interface JobStatuses {
  pending: string;
  running: string;
  done: string;
  failed: string;
}

export interface JobContext<C> {
  jobId: string;
  runToken: string;
  /** Чекпойнт с прошлого захвата или null. */
  checkpoint: C | null;
  /** Взводится при shutdown и при потере аренды. Передавать в fetch/паузы. */
  signal: AbortSignal;
  shouldStop(): boolean;
  /** false — строку перехватили: прекратить работу над задачей. */
  saveCheckpoint(data: C): Promise<boolean>;
  log: JobLogger;
}

/**
 * Минимальный срез supabase-js, который использует библиотека (и который умеет
 * фейк в тестах). Тип запроса — any: цепочка PostgREST-билдера меняет форму на
 * каждом шаге, а нам от неё нужны только .data/.error в конце.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type QueryBuilder = any;
export type JobDbClient = { from(table: string): QueryBuilder };

export interface JobRunnerOptions<Row extends { id: string }, C> {
  table: string;
  workerId: string;
  statuses: JobStatuses;
  /** Аренда в секундах; продление каждые leaseSeconds/3. */
  leaseSeconds: number;
  /** Сколько потерь аренды / исключений до status=failed. По умолчанию 3. */
  maxAttempts?: number;
  /** Сколько задач одновременно на этой реплике. По умолчанию 1. */
  concurrency?: number;
  /** Колонка порядка захвата pending. По умолчанию created_at. */
  orderBy?: string;
  /** Что читать в job для run(). id, checkpoint, attempts, run_token добавляются всегда. */
  select?: string;
  /** Дополнительные поля при захвате (например started_at). */
  claimPatch?: () => Record<string, unknown>;
  /** Дополнительные поля при переводе в failed (например error_message). */
  failedPatch?: (reason: string) => Record<string, unknown>;
  /**
   * true (по умолчанию): библиотека сама ставит done/failed/pending по итогу run().
   * false: run() пишет терминальный статус сам (конструктор баз, TG-парсер);
   * библиотека тогда только держит аренду и отпускает её при остановке.
   */
  manageTerminalStatus?: boolean;
  /** Сколько ждать run-промисы после сигнала. По умолчанию 10 с. */
  shutdownGraceMs?: number;
  now?: () => number;
  db?: JobDbClient;
  log: JobLogger;
  run(job: Row & { checkpoint: C | null; attempts: number }, ctx: JobContext<C>): Promise<void>;
}

export interface JobRunner {
  /** Один опрос: взял задачу → true (зови снова), нечего брать → false. */
  pollOnce(): Promise<boolean>;
  /** Идемпотентно. Отпускает аренды, прерывает run(), ждёт до shutdownGraceMs. */
  shutdown(): Promise<void>;
  activeJobIds(): string[];
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** Таймер продления не должен держать процесс живым, если воркер уже всё доделал. */
function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  const maybe = timer as unknown as { unref?: () => void };
  if (typeof maybe.unref === 'function') maybe.unref();
}

export function createJobRunner<Row extends { id: string }, C = unknown>(
  opts: JobRunnerOptions<Row, C>,
): JobRunner {
  const db: JobDbClient | null = opts.db ?? (supabaseAdmin as unknown as JobDbClient | null);
  if (!db) throw new Error('createJobRunner: supabaseAdmin is not configured');
  const {
    table, workerId, statuses, log,
    maxAttempts = 3, concurrency = 1, orderBy = 'created_at',
    manageTerminalStatus = true, shutdownGraceMs = 10_000,
  } = opts;
  const now = opts.now ?? Date.now;
  const leaseMs = Math.max(1_000, opts.leaseSeconds * 1_000);
  const heartbeatMs = Math.max(1_000, Math.floor(leaseMs / 3));
  // run_token обязателен в выборке: по нему ограждаются все дальнейшие записи.
  const baseSelect = 'id, checkpoint, attempts, run_token';
  const select = opts.select ? `${baseSelect}, ${opts.select}` : baseSelect;

  type ClaimedJob = Row & { checkpoint: C | null; attempts: number };

  const iso = (ms: number) => new Date(ms).toISOString();
  const leaseUntil = () => iso(now() + leaseMs);
  /**
   * PostgREST-фильтр «аренда истекла или обнулена». Значение в кавычках:
   * внутри ISO-даты есть точки, без кавычек грамматика or=(…) режет их как
   * разделители оператора.
   */
  const expiredFilter = () => `lease_until.is.null,lease_until.lt."${iso(now())}"`;
  const clearOwnership = { lease_until: null, run_token: null, worker_id: null };

  type Owned = { runToken: string; abort: AbortController; promise: Promise<void> };
  const owned = new Map<string, Owned>();
  let stopping = false;

  /** UPDATE с ограждением по жетону. true — строка наша (или БД моргнула), false — перехвачена. */
  async function fencedUpdate(
    jobId: string,
    runToken: string,
    patch: Record<string, unknown>,
  ): Promise<boolean> {
    const { data, error } = await db!
      .from(table)
      .update(patch)
      .eq('id', jobId)
      .eq('status', statuses.running)
      .eq('run_token', runToken)
      .select('id')
      .maybeSingle();
    if (error) {
      // Сбой сети — не доказательство потери владения: все записи и так
      // ограждены жетоном, а ложный abort стоил бы часов работы.
      log('warn', `[${table}] fenced update failed for ${jobId}: ${error.message}`);
      return true;
    }
    return !!data;
  }

  async function claimPending(): Promise<ClaimedJob | null> {
    const { data: candidate } = await db!
      .from(table)
      .select('id, attempts')
      .eq('status', statuses.pending)
      .order(orderBy, { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!candidate) return null;
    const runToken = randomUUID();
    const { data } = await db!
      .from(table)
      .update({
        status: statuses.running,
        run_token: runToken,
        worker_id: workerId,
        lease_until: leaseUntil(),
        ...(opts.claimPatch?.() ?? {}),
      })
      .eq('id', candidate.id)
      // CAS: строку получит ровно та реплика, для которой она ещё pending.
      .eq('status', statuses.pending)
      .select(select)
      .maybeSingle();
    return (data as ClaimedJob | null) ?? null;
  }

  async function claimExpired(): Promise<ClaimedJob | null> {
    const { data: candidate } = await db!
      .from(table)
      .select('id, attempts, lease_until')
      .eq('status', statuses.running)
      .or(expiredFilter())
      .order(orderBy, { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!candidate) return null;
    // null — чистая передача при shutdown, не попытка. Иначе — crash/kill.
    const lost = candidate.lease_until != null;
    const attempts = (candidate.attempts ?? 0) + (lost ? 1 : 0);
    if (lost && attempts >= maxAttempts) {
      const reason = `исполнитель терял задачу ${attempts} раз(а) подряд — остановлено`;
      await db!
        .from(table)
        .update({
          status: statuses.failed,
          attempts,
          ...clearOwnership,
          ...(opts.failedPatch?.(reason) ?? {}),
        })
        .eq('id', candidate.id)
        .eq('status', statuses.running)
        .or(expiredFilter())
        .select('id')
        .maybeSingle();
      log('warn', `[${table}] job ${candidate.id} failed: ${reason}`);
      return null;
    }
    const runToken = randomUUID();
    const { data } = await db!
      .from(table)
      .update({ run_token: runToken, worker_id: workerId, lease_until: leaseUntil(), attempts })
      .eq('id', candidate.id)
      .eq('status', statuses.running)
      // Тот же фильтр в UPDATE: между чтением кандидата и записью аренду мог
      // перехватить сосед — тогда строка уже не «истёкшая» и мы её не тронем.
      .or(expiredFilter())
      .select(select)
      .maybeSingle();
    if (data) log('info', `[${table}] reclaimed job ${candidate.id} (${lost ? 'lease expired' : 'released'})`);
    return (data as ClaimedJob | null) ?? null;
  }

  function execute(job: ClaimedJob): void {
    const runToken = String((job as unknown as Record<string, unknown>).run_token ?? '');
    const abort = new AbortController();
    const jobLog: JobLogger = (level, msg, extra) => log(level, `[${table}][${job.id}] ${msg}`, extra);

    const heartbeat = async () => {
      if (stopping || isShuttingDown() || abort.signal.aborted) return;
      const ok = await fencedUpdate(job.id, runToken, { lease_until: leaseUntil() });
      if (!ok && !abort.signal.aborted) {
        jobLog('warn', 'lease lost to another worker — aborting');
        abort.abort('lease-lost');
      }
    };
    const timer = setInterval(() => { void heartbeat(); }, heartbeatMs);
    unrefTimer(timer);

    const ctx: JobContext<C> = {
      jobId: job.id,
      runToken,
      checkpoint: (job.checkpoint ?? null) as C | null,
      signal: abort.signal,
      shouldStop: () => stopping || abort.signal.aborted,
      log: jobLog,
      saveCheckpoint: async (data) => {
        if (abort.signal.aborted) return false;
        const patch: Record<string, unknown> = { checkpoint: data };
        // Во время остановки чекпойнт сохраняем, а аренду не продлеваем:
        // именно продление в shutdown отменяло быструю передачу (11.08.2026).
        if (!stopping && !isShuttingDown()) patch.lease_until = leaseUntil();
        const ok = await fencedUpdate(job.id, runToken, patch);
        if (!ok) {
          jobLog('warn', 'checkpoint rejected — job was reclaimed, aborting');
          abort.abort('lease-lost');
        }
        return ok;
      },
    };

    // Владение регистрируем ДО запуска тела: и сам run (shouldStop,
    // saveCheckpoint), и finally с owned.delete обязаны видеть готовую карту.
    const entry: Owned = { runToken, abort, promise: Promise.resolve() };
    owned.set(job.id, entry);

    // Тело задачи стартует отдельной микротаской: pollOnce обязан вернуть
    // управление циклу опроса, а не выполнять код воркера в своём стеке.
    // Иначе задача, падающая сразу, успевает вернуться в pending внутри того
    // же опроса и он же захватывает её снова — все maxAttempts сгорают за
    // микросекунды, а остальная очередь стоит.
    entry.promise = Promise.resolve().then(async () => {
      try {
        await opts.run(job, ctx);
        if (manageTerminalStatus && !abort.signal.aborted) {
          await fencedUpdate(job.id, runToken, { status: statuses.done, ...clearOwnership });
        }
      } catch (err) {
        if (abort.signal.aborted) {
          jobLog('info', 'run interrupted (shutdown or lease lost); row left for reclaim');
          return;
        }
        const reason = err instanceof Error ? err.message : String(err);
        jobLog('error', `run failed: ${reason}`, err);
        if (!manageTerminalStatus) return;
        const attempts = (job.attempts ?? 0) + 1;
        if (attempts >= maxAttempts) {
          await fencedUpdate(job.id, runToken, {
            status: statuses.failed, attempts, ...clearOwnership, ...(opts.failedPatch?.(reason) ?? {}),
          });
        } else {
          await fencedUpdate(job.id, runToken, { status: statuses.pending, attempts, ...clearOwnership });
        }
      } finally {
        clearInterval(timer);
        if (owned.get(job.id)?.runToken === runToken) owned.delete(job.id);
      }
    });
  }

  return {
    async pollOnce() {
      if (stopping) return false;
      if (owned.size >= concurrency) {
        await sleep(500);
        return true;
      }
      const job = (await claimPending()) ?? (await claimExpired());
      if (!job) return false;
      execute(job);
      return true;
    },

    async shutdown() {
      if (stopping) return;
      stopping = true;
      markShuttingDown();
      const snapshot = Array.from(owned.entries());
      for (const [, o] of snapshot) o.abort.abort('shutdown');
      const release = () =>
        Promise.all(snapshot.map(([id, o]) => fencedUpdate(id, o.runToken, { lease_until: null })));
      if (snapshot.length > 0) {
        log('info', `[${table}] releasing ${snapshot.length} job(s) for fast handoff: ${snapshot.map(([id]) => id).join(', ')}`);
        await release();
        // Второй проход: продление, улетевшее в PostgREST до сигнала, могло
        // приземлиться после первого и снова сделать аренду живой.
        await sleep(1_000);
        await release();
      }
      await Promise.race([
        Promise.allSettled(snapshot.map(([, o]) => o.promise)),
        sleep(shutdownGraceMs),
      ]);
    },

    activeJobIds: () => Array.from(owned.keys()),
  };
}

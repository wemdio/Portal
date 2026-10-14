/**
 * Аренда запуска автоаутрича воркером — отметка progress_detail.worker.
 *
 * Остановленный запуск (status failed) воркер ещё доводит: обрывает идущие
 * вызовы ИИ, ждёт, пока они спишутся, и последней записью кладёт в
 * progress_detail итог расхода. «Переписать цепочку», начатая в это время,
 * дописала бы в тот же progress_detail свой расход, пересчитанные счётчики и
 * свою отметку — а итоговая запись воркера стёрла бы их целиком. Поэтому воркер
 * держит аренду { token, until }, и пока она жива, роут «Переписать цепочку»
 * отвечает «запуск ещё останавливается».
 *
 * Воркер ставит отметку при старте — только идущему запуску, так что
 * остановленный или законченный запуск (его в это время может переписывать
 * роут) заново не начнётся. Каждая запись progress_detail воркера несёт
 * отметку и пишется только при ней: переживший аренду процесс ничего не
 * перетрёт, а увидев, что отметки нет, останавливает свой прогон (onLost).
 * Последняя запись воркера снимает отметку.
 *
 * Пока запуск идёт, роут его и так не пускает, поэтому продление без дела
 * progress_detail не трогает: монитор здоровья (services/health-check) видит
 * зависший запуск по неизменному прогрессу, и лишние записи его бы ослепили.
 * Воркер пишет, когда что-то изменилось (расход на ИИ — не реже раза в 30 с),
 * а срок аренды держит свежим с той минуты, как заметил остановку, и до
 * итоговой записи. Первые минуты после остановки воркер её ещё не заметил —
 * аренду тогда держит сама остановка: completed_at моложе двух минут
 * (WORKER_STOP_GRACE_MS). Воркер умер — через две минуты после остановки роут
 * забирает запуск и снимает отметку сравнением с обменом.
 *
 * Колонок аренды у parser_jobs в этой ветке нет (единый жизненный цикл задач
 * живёт в ветке dmitriy_kuladmed), поэтому отметка — в progress_detail, как и
 * отметка пересборки русского аутрича (progress_detail.rebuilding).
 *
 * Здесь же — проверка остановки (JobStatusReader): остановкой считается только
 * прочитанный статус, а не сбой чтения.
 */

import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export const WORKER_LEASE_KEY = 'worker';
/**
 * Путь отметки для фильтра PostgREST — запись «только при своей отметке»:
 * .eq(WORKER_LEASE_TOKEN_PATH, owner.token). Так пишет и публикация прогресса
 * раннера: второй процесс с тем же запуском (перезапуск воркера при живом
 * старом) не перетрёт отметку нового прогона своей.
 */
export const WORKER_LEASE_TOKEN_PATH = `progress_detail->${WORKER_LEASE_KEY}->>token`;
const TOKEN_PATH = WORKER_LEASE_TOKEN_PATH;
/** Срок аренды от последней записи воркера. */
export const WORKER_LEASE_MS = 120_000;
/**
 * Сколько после остановки (completed_at) аренда считается живой, даже если её
 * срок вышел: воркер замечает остановку за 15 с (опрос статуса) и с этой
 * минуты сам держит срок свежим.
 */
export const WORKER_STOP_GRACE_MS = 120_000;
const HEARTBEAT_MS = 30_000;
/** Внеочередное сохранение (расход писателя) — не чаще этого. */
const SAVE_GAP_MS = 5_000;
const FINAL_WRITE_ATTEMPTS = 3;
const FINAL_WRITE_PAUSE_MS = 1_000;

/**
 * Сколько статус запуска может не читаться подряд — ни проверкой перед
 * строкой, ни опросом раз в 15 с, — прежде чем воркер прервёт запуск.
 * Одиночный сбой PostgREST (5xx, таймаут) остановкой не считается, но и долго
 * работать, не видя «Остановить», нельзя: ИИ тратился бы вслепую.
 */
export const STATUS_UNREADABLE_MS = 3 * 60_000;
export const STATUS_UNREADABLE_TEXT =
  `База не отвечает больше ${STATUS_UNREADABLE_MS / 60_000} минут — запуск прерван, чтобы не тратить ИИ, не видя команды «Остановить»`;
/**
 * Итог запуска, который воркер оборвал, хотя «Остановить» никто не нажимал:
 * без него запуск навсегда остался бы «идущим» без воркера (JobOwner.writeCancelled).
 */
export const ABANDONED_RUN_TEXT =
  'Запуск прервался без команды «Остановить» — готовые компании сохранены, остальные не обработаны';

export interface WorkerLease {
  token: string;
  until: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function workerLeaseOf(detail: unknown): WorkerLease | null {
  const raw = asRecord(asRecord(detail)?.[WORKER_LEASE_KEY]);
  if (!raw) return null;
  return typeof raw.token === 'string' && typeof raw.until === 'string' ? { token: raw.token, until: raw.until } : null;
}

/**
 * Воркер ещё держит запуск: срок аренды не вышел или запуск остановили меньше
 * WORKER_STOP_GRACE_MS назад (воркер мог ещё не заметить остановку). Битая
 * отметка — не держит: иначе запуск нельзя было бы переписать никогда.
 */
export function workerLeaseLive(detail: unknown, completedAt?: string | null, now = Date.now()): boolean {
  const lease = workerLeaseOf(detail);
  if (!lease) return false;
  const until = Date.parse(lease.until);
  if (Number.isFinite(until) && until > now) return true;
  const stoppedAt = completedAt ? Date.parse(completedAt) : NaN;
  return Number.isFinite(stoppedAt) && now - stoppedAt < WORKER_STOP_GRACE_MS;
}

export function withoutWorkerLease(detail: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...detail };
  delete rest[WORKER_LEASE_KEY];
  return rest;
}

/** Статус запуска: status null — запуска больше нет (удалён); ok false — не прочитался. */
export type JobStatusRead = { ok: true; status: string | null } | { ok: false; error: string };

/**
 * Статус запуска для проверки остановки — перед каждой строкой и опросом раз
 * в 15 с. Остановка — только прочитанный статус «не идёт» (или запуска больше
 * нет). Сбой чтения — не остановка: раньше одна ошибка PostgREST обрывала
 * здоровый запуск, статус при этом никто не менял, и запуск навсегда
 * оставался «идущим» без воркера (очередь берёт только pending). Не читается
 * дольше STATUS_UNREADABLE_MS подряд — unreadableTooLong(): раннер прерывает
 * запуск с понятной причиной.
 */
export class JobStatusReader {
  /** С какой минуты подряд не удаётся ни одно чтение; null — последнее удалось. */
  private unreadableSince: number | null = null;

  constructor(
    private readonly db: SupabaseClient,
    private readonly jobId: string,
  ) {}

  async read(): Promise<JobStatusRead> {
    let problem: string;
    try {
      const { data, error } = await this.db.from('parser_jobs').select('status').eq('id', this.jobId).maybeSingle();
      if (!error) {
        this.unreadableSince = null;
        return { ok: true, status: data ? String(data.status) : null };
      }
      problem = error.message;
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
    }
    this.unreadableSince ??= Date.now();
    return { ok: false, error: problem };
  }

  /** Все чтения статуса не удаются подряд дольше STATUS_UNREADABLE_MS. */
  unreadableTooLong(now = Date.now()): boolean {
    return this.unreadableSince !== null && now - this.unreadableSince >= STATUS_UNREADABLE_MS;
  }
}

type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

export interface JobOwnerOptions {
  /** Воркер — service role. */
  db: SupabaseClient;
  jobId: string;
  log: Log;
  /** Отметку сняли (роут забрал запуск после истёкшей аренды) — остановить прогон. */
  onLost: () => void;
}

/** Итог записи: легла; не легла — отметки нет или запуск уже не идёт; сбой базы. */
export type OwnerWrite = 'written' | 'skipped' | 'error';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Аренда запуска одним прогоном воркера: отметка, сохранение расхода, итоговая запись. */
export class JobOwner {
  readonly token = randomUUID();
  private detail: (() => Record<string, unknown>) | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Записи продления идут строго по очереди: итог встаёт после последней из них. */
  private queue: Promise<void> = Promise.resolve();
  private beatQueued = false;
  private lastBeat = 0;
  /** Что записало последнее продление (без отметки): без изменений запись не нужна. */
  private lastWritten = '';
  /** Воркер заметил остановку или сбой: с этой минуты срок аренды держим свежим. */
  private winding = false;
  private closed = false;
  private lost = false;

  constructor(private readonly opts: JobOwnerOptions) {}

  /**
   * Отметка для progress_detail. Её несёт каждая запись progress_detail
   * воркера: запись без неё сняла бы аренду, и продление решило бы, что запуск
   * отобрали.
   */
  lease(): WorkerLease {
    return { token: this.token, until: new Date(Date.now() + WORKER_LEASE_MS).toISOString() };
  }

  /**
   * Занять запуск — только идущий. false: запуск уже остановлен (между
   * захватом из очереди и стартом) или удалён — работать нельзя. Сбой базы —
   * ошибка: без отметки прогон не защищён.
   */
  async claim(previousDetail: Record<string, unknown> | null): Promise<boolean> {
    const progressDetail = { ...withoutWorkerLease(previousDetail ?? {}), [WORKER_LEASE_KEY]: this.lease() };
    const { data, error } = await this.opts.db
      .from('parser_jobs')
      .update({ progress_detail: progressDetail })
      .eq('id', this.opts.jobId)
      .eq('status', 'running')
      .select('id');
    if (error) throw new Error(`Не удалось занять запуск: ${error.message}`);
    return Boolean(data?.length);
  }

  /**
   * Продление раз в 30 с: пишет текущий progress_detail (в нём и расход на ИИ),
   * если он изменился, а после остановки (winding) — всегда, освежая срок.
   */
  start(detail: () => Record<string, unknown>): void {
    this.detail = detail;
    if (this.heartbeat || this.closed) return;
    this.heartbeat = setInterval(() => this.enqueueBeat(), HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  /** Сохранить progress_detail вне очереди продлений (расход писателя цепочек) — не чаще раза в 5 с. */
  save(): void {
    if (this.closed || this.lost || !this.detail || this.saveTimer) return;
    const wait = Math.max(0, this.lastBeat + SAVE_GAP_MS - Date.now());
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.enqueueBeat();
    }, wait);
    this.saveTimer.unref?.();
  }

  /**
   * Воркер заметил остановку или сбой: итог ещё впереди (оборванные вызовы,
   * строки), и с этой минуты срок аренды держится свежим — роут ждёт итога.
   */
  windDown(): void {
    if (this.winding) return;
    this.winding = true;
    this.enqueueBeat();
  }

  private enqueueBeat(): void {
    if (this.closed || this.lost || !this.detail || this.beatQueued) return;
    this.beatQueued = true;
    this.queue = this.queue.then(async () => {
      this.beatQueued = false;
      await this.beat();
    });
  }

  private async beat(): Promise<void> {
    if (this.closed || this.lost || !this.detail) return;
    try {
      const current = withoutWorkerLease(this.detail());
      const key = JSON.stringify(current);
      // Без изменений и до остановки — ничего не пишем: монитор здоровья видит
      // зависший запуск по неизменному прогрессу.
      if (!this.winding && key === this.lastWritten) return;
      this.lastBeat = Date.now();
      const { data, error } = await this.opts.db
        .from('parser_jobs')
        .update({ progress_detail: { ...current, [WORKER_LEASE_KEY]: this.lease() } })
        .eq('id', this.opts.jobId)
        .eq(TOKEN_PATH, this.token)
        .select('id');
      if (error) {
        // Сбой базы — не потеря запуска: следующее продление попробует снова.
        this.opts.log('warn', `job ${this.opts.jobId}: lease heartbeat failed`, error);
        return;
      }
      if (data?.length) {
        this.lastWritten = key;
        return;
      }
      if (this.closed) return;
      // Ни одной строки — отметку сняли. Прежде чем обрывать прогон,
      // перепроверяем простым чтением: не прочиталось — решит следующее
      // продление; отметка на месте — не сработал фильтр по jsonb, прогон не
      // трогаем (громкая ошибка в лог).
      const check = await this.leaseCheck();
      if (!check || this.closed) return;
      if (check.ours) {
        this.opts.log('error', `job ${this.opts.jobId}: lease heartbeat matched no row although the lease is ours — check the PostgREST jsonb filter`);
        return;
      }
      this.lost = true;
      this.stopTimers();
      this.opts.log('warn', `job ${this.opts.jobId}: worker lease is gone — the run was taken over, stopping it`);
      this.opts.onLost();
    } catch (err) {
      this.opts.log('warn', `job ${this.opts.jobId}: lease heartbeat failed`, err instanceof Error ? err.message : err);
    }
  }

  /** Отметка в базе — наша? Чтение без фильтра по jsonb. null — не прочиталось. */
  private async leaseCheck(): Promise<{ ours: boolean; status: string | null } | null> {
    const { data, error } = await this.opts.db.from('parser_jobs').select('status,progress_detail').eq('id', this.opts.jobId).maybeSingle();
    if (error) return null;
    if (!data) return { ours: false, status: null };
    return { ours: workerLeaseOf(data.progress_detail)?.token === this.token, status: String(data.status ?? '') };
  }

  private stopTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.heartbeat = null;
    this.saveTimer = null;
  }

  /**
   * Больше не продлевать: дальше только итоговые записи (write). Запись
   * продления в полёте дожидаемся — иначе она легла бы после итога и вернула
   * отметку.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.stopTimers();
    await this.queue;
  }

  /**
   * Итоговая запись: только при своей отметке (и только идущему запуску, если
   * requireRunning). Отметка из progress_detail снимается — аренда отпущена.
   * Сбой базы — ещё две попытки.
   */
  async write(patch: Record<string, unknown>, options: { requireRunning?: boolean } = {}): Promise<OwnerWrite> {
    if (this.lost) return 'skipped';
    const detail = asRecord(patch.progress_detail);
    const body = detail ? { ...patch, progress_detail: withoutWorkerLease(detail) } : patch;
    for (let attempt = 1; attempt <= FINAL_WRITE_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(FINAL_WRITE_PAUSE_MS);
      let query = this.opts.db.from('parser_jobs').update(body).eq('id', this.opts.jobId).eq(TOKEN_PATH, this.token);
      if (options.requireRunning) query = query.eq('status', 'running');
      const { data, error } = await query.select('id');
      if (error) {
        this.opts.log('warn', `job ${this.opts.jobId}: final progress write failed (attempt ${attempt}/${FINAL_WRITE_ATTEMPTS})`, error);
        continue;
      }
      if (data?.length) return 'written';
      // Ни одной строки: запуск забрали или (requireRunning) он уже не идёт.
      // Перепроверяем чтением: отметка наша и статус подходит — значит, не
      // сработал фильтр по jsonb, и итог пишем по id, иначе запуск остался бы
      // «идущим» без итога.
      const check = await this.leaseCheck();
      if (!check) continue;
      if (!check.ours || (options.requireRunning && check.status !== 'running')) return 'skipped';
      this.opts.log('error', `job ${this.opts.jobId}: final write matched no row although the lease is ours — writing by id (check the PostgREST jsonb filter)`);
      let plain = this.opts.db.from('parser_jobs').update(body).eq('id', this.opts.jobId);
      if (options.requireRunning) plain = plain.eq('status', 'running');
      const { data: saved, error: plainErr } = await plain.select('id');
      if (plainErr) {
        this.opts.log('warn', `job ${this.opts.jobId}: final progress write failed (attempt ${attempt}/${FINAL_WRITE_ATTEMPTS})`, plainErr);
        continue;
      }
      return saved?.length ? 'written' : 'skipped';
    }
    return 'error';
  }

  /**
   * Итог оборванного прогона. Статус обычно уже поставил тот, кто остановил,
   * — дописываем только прогресс и расход. Но если запуск всё ещё «идёт» под
   * нашей отметкой, его никто не останавливал, а воркер уходит: без failed он
   * навсегда остался бы «идущим» (очередь берёт только pending, «Переписать
   * цепочку» и заливка идущий не трогают). Проверка и запись — одним условным
   * обновлением: остановку, пришедшую в тот же миг, не перетираем.
   */
  async writeCancelled(progressDetail: Record<string, unknown>): Promise<OwnerWrite> {
    const failed = await this.write(
      {
        status: 'failed',
        progress_stage: 'failed',
        completed_at: new Date().toISOString(),
        error_message: ABANDONED_RUN_TEXT,
        progress_detail: progressDetail,
      },
      { requireRunning: true },
    );
    if (failed === 'written') {
      this.opts.log('warn', `job ${this.opts.jobId}: the run was cut short although nobody stopped it — marked failed`);
      return failed;
    }
    if (failed === 'error') return failed;
    return this.write({ progress_detail: progressDetail });
  }
}

/**
 * Email validation worker.
 *
 * Processes email_validation_queue items in batches with:
 *  - Per-domain concurrency limiting (1 SMTP connection per domain at a time)
 *  - Domain-level MX / catch-all caching (shared across items)
 *  - Greylisting retry (re-queues items with 'pending' for later attempt)
 *  - Stale processing recovery
 *  - Graceful cancellation
 */

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logError, logInfo } from '@/lib/loggerServer';
import { validateEmail, type ValidationResult, type DomainInfo } from './validator';
import { startTrace } from '@/lib/tracer';
import type { Span } from '@/lib/tracer';

function workerLog(level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) {
  const line = `[email-validation][${level.toUpperCase()}] ${msg}`;
  if (extra !== undefined) console[level](line, extra);
  else console[level](line);
}

type QueueItem = {
  id: string;
  job_id: string;
  row_index: number;
  email_raw: string;
  email_normalized: string;
  attempt_count: number;
};

type JobRow = {
  id: string;
  user_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  total: number;
  processed: number;
  success_count: number;
  error_count: number;
};

// ─── Configuration ──────────────────────────────────────────────────────────

const WORKER_CONCURRENCY = Number(process.env.EMAIL_VALIDATION_CONCURRENCY ?? '20');
const WORKER_BATCH_SIZE = Number(process.env.EMAIL_VALIDATION_BATCH_SIZE ?? '100');
export const MAX_ATTEMPTS = Number(process.env.EMAIL_VALIDATION_MAX_ATTEMPTS ?? '3');
const STALE_PROCESSING_MINUTES = Number(process.env.EMAIL_VALIDATION_STALE_MINUTES ?? '5');
const DOMAIN_CONCURRENCY = Number(process.env.EMAIL_VALIDATION_DOMAIN_CONCURRENCY ?? '3');
const DOMAIN_CACHE_TTL_MS = Number(process.env.EMAIL_VALIDATION_DOMAIN_CACHE_TTL_MS ?? String(24 * 60 * 60 * 1000));
const JOB_PROGRESS_FLUSH_INTERVAL = Number(process.env.EMAIL_VALIDATION_PROGRESS_FLUSH_MS ?? '2000');
const SUPABASE_QUERY_TIMEOUT_MS = 30_000;

/**
 * Пауза, которую можно прервать сигналом остановки.
 *
 * Ожидание ближайшего отложенного ретрая доходит до RETRY_WAIT_CAP_MS (60 с), и
 * отключённое от задачи тело столько спать не должно: пока оно спит, задачу уже
 * ведёт новый владелец. Резолвится, а не бросает — решение, что делать с
 * отменой, принимает вызывающий код (тот же приём, что в
 * lib/parsers/searchParserWorker.ts).
 */
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    // AbortSignal не переигрывает уже случившуюся отмену для поздних
    // слушателей — поэтому проверка выше идёт до подписки.
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });

// ─── Helpers ────────────────────────────────────────────────────────────────

function withTimeout<T>(operation: PromiseLike<T>, msg: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(msg)), SUPABASE_QUERY_TIMEOUT_MS);
    Promise.resolve(operation).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const run = async () => {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await worker(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}

const CLEANUP_BATCH_SIZE = 5000;
// Grace before a finished job's queue rows may be purged. The UI polls the
// results endpoint (which reads email_validation_queue by cursor) for a while
// AFTER a job flips to completed — deleting inline raced that read and dropped
// unfetched results, so we only purge jobs that finished at least this long ago.
const CLEANUP_GRACE_MS = Number(
  process.env.EMAIL_VALIDATION_CLEANUP_GRACE_MS ?? String(60 * 60 * 1000),
);
const CLEANUP_JOBS_PER_PASS = 25;

/**
 * Purge queue rows of jobs that finished long enough ago that no client is still
 * paging their results. NEVER touches a running/pending job's rows (status
 * filter) nor the just-finished job (grace period). Runs a bit each time a job
 * finishes, so the table self-drains without racing the UI.
 *
 * (Replaces the old per-jobId inline cleanup, which (a) used `.limit()` WITHOUT
 * an `.order()` and so failed with PostgREST PGRST109 — deleting nothing and
 * bloating the queue to >1M rows — and (b) raced the client's result feed.)
 */
async function cleanupOldQueues(): Promise<void> {
  const db = supabaseAdmin;
  if (!db) return;
  try {
    const cutoff = new Date(Date.now() - CLEANUP_GRACE_MS).toISOString();
    const { data: oldJobs, error } = await db
      .from('email_validation_jobs')
      .select('id')
      .in('status', ['completed', 'failed', 'cancelled'])
      .lt('completed_at', cutoff)
      .limit(CLEANUP_JOBS_PER_PASS);
    if (error || !oldJobs || oldJobs.length === 0) return;

    let totalDeleted = 0;
    for (const job of oldJobs) {
      while (true) {
        const { data, error: delErr } = await db
          .from('email_validation_queue')
          .delete()
          .eq('job_id', job.id)
          .order('id') // required: PostgREST rejects a limit without an explicit order
          .limit(CLEANUP_BATCH_SIZE)
          .select('id');
        if (delErr) {
          workerLog('warn', `Cleanup error for job ${job.id}`, delErr);
          break;
        }
        const deleted = data?.length ?? 0;
        totalDeleted += deleted;
        if (deleted < CLEANUP_BATCH_SIZE) break;
      }
    }
    if (totalDeleted > 0) {
      workerLog('info', `Cleaned up ${totalDeleted} old queue items across ${oldJobs.length} finished job(s)`);
    }
  } catch (err) {
    workerLog('warn', 'cleanupOldQueues failed', err);
  }
}

// ─── Per-domain slot limiter ────────────────────────────────────────────────

const domainActive = new Map<string, number>();
const domainQueue = new Map<string, Array<() => void>>();

async function acquireDomainSlot(domain: string): Promise<() => void> {
  if (!domain || DOMAIN_CONCURRENCY <= 0) return () => {};
  const current = domainActive.get(domain) ?? 0;
  if (current >= DOMAIN_CONCURRENCY) {
    await new Promise<void>((resolve) => {
      const q = domainQueue.get(domain) ?? [];
      q.push(resolve);
      domainQueue.set(domain, q);
    });
  }
  domainActive.set(domain, (domainActive.get(domain) ?? 0) + 1);
  return () => {
    const next = (domainActive.get(domain) ?? 1) - 1;
    if (next <= 0) domainActive.delete(domain);
    else domainActive.set(domain, next);
    const q = domainQueue.get(domain);
    const resolver = q?.shift();
    if (resolver) resolver();
  };
}

// ─── Domain cache persistence ───────────────────────────────────────────────

/**
 * Сигнатура полей записи кэша, релевантных для upsert'а (checkedAt НЕ входит —
 * validateEmail мутирует isCatchAll in-place, не трогая checkedAt). Сравнение
 * со снапшотом, снятым при загрузке, показывает, какие записи реально созданы
 * или изменены за прогон: ТОЛЬКО их и апсертим. Раньше saveDomainCache
 * переписывал expires_at ВСЕХ загруженных строк — TTL «отмывался» на каждом
 * джобе и записи жили вечно (TTL laundering).
 */
export function domainInfoSignature(d: DomainInfo): string {
  return JSON.stringify([d.mxHosts, d.mxFound, d.isCatchAll, d.isDisposable]);
}

/** Записи кэша, созданные или изменённые за прогон (новые + отличающиеся от снапшота). */
export function filterDirtyCacheEntries(
  cache: Map<string, DomainInfo>,
  snapshot: Map<string, string>,
): DomainInfo[] {
  return Array.from(cache.values()).filter(
    (d) => snapshot.get(d.domain) !== domainInfoSignature(d),
  );
}

// Distinct-домены очереди джоба (узкая колонка, постранично — страница не
// должна превышать PostgREST max-rows, иначе хвост молча обрежется).
async function loadJobDomains(jobId: string): Promise<string[]> {
  if (!supabaseAdmin) return [];
  const domains = new Set<string>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    try {
      const { data, error } = await supabaseAdmin
        .from('email_validation_queue')
        .select('email_normalized')
        .eq('job_id', jobId)
        .order('row_index')
        .range(from, from + PAGE - 1);
      if (error) {
        await logError('email.validation.worker.job_domains_load_failed', error, { jobId });
        break;
      }
      const rows = data ?? [];
      for (const r of rows) {
        const d = String((r as { email_normalized?: string }).email_normalized ?? '').split('@')[1];
        if (d) domains.add(d);
      }
      if (rows.length < PAGE) break;
    } catch (err) {
      await logError('email.validation.worker.job_domains_load_failed', err, { jobId });
      break;
    }
  }
  return Array.from(domains);
}

/**
 * Грузим кэш ТОЛЬКО для доменов этого джоба (чанки .in() по несколько сотен),
 * а не первые 10000 строк без ORDER BY, как раньше. Возвращает кэш и снапшот
 * сигнатур загруженных записей — для dirty-фильтра в saveDomainCache.
 */
async function loadDomainCache(
  jobId: string,
  domains: string[],
): Promise<{ cache: Map<string, DomainInfo>; snapshot: Map<string, string> }> {
  const cache = new Map<string, DomainInfo>();
  const snapshot = new Map<string, string>();
  if (!supabaseAdmin || domains.length === 0) return { cache, snapshot };

  const CHUNK = 300;
  for (let i = 0; i < domains.length; i += CHUNK) {
    try {
      const { data, error } = await supabaseAdmin
        .from('email_validation_domain_cache')
        .select('domain, mx_hosts, mx_found, is_catch_all, is_disposable, checked_at, expires_at')
        .in('domain', domains.slice(i, i + CHUNK))
        .gt('expires_at', new Date().toISOString());
      if (error) {
        await logError('email.validation.worker.domain_cache_load_failed', error, { jobId });
        continue;
      }
      for (const row of data ?? []) {
        const info: DomainInfo = {
          domain: row.domain,
          mxHosts: row.mx_hosts ?? [],
          mxFound: row.mx_found ?? false,
          isCatchAll: row.is_catch_all,
          isDisposable: row.is_disposable ?? false,
          checkedAt: new Date(row.checked_at),
        };
        cache.set(row.domain, info);
        snapshot.set(row.domain, domainInfoSignature(info));
      }
    } catch (err) {
      await logError('email.validation.worker.domain_cache_load_failed', err, { jobId });
    }
  }

  return { cache, snapshot };
}

async function saveDomainCache(
  domainCache: Map<string, DomainInfo>,
  snapshot: Map<string, string>,
): Promise<void> {
  if (!supabaseAdmin || domainCache.size === 0) return;

  // Апсертим только созданные/изменённые за прогон записи; нетронутые строки
  // сохраняют исходные checked_at/expires_at (см. domainInfoSignature).
  const dirty = filterDirtyCacheEntries(domainCache, snapshot);
  if (dirty.length === 0) return;

  const rows = dirty.map((d) => ({
    domain: d.domain,
    mx_hosts: d.mxHosts,
    mx_found: d.mxFound,
    is_catch_all: d.isCatchAll,
    is_disposable: d.isDisposable,
    checked_at: d.checkedAt.toISOString(),
    expires_at: new Date(Date.now() + DOMAIN_CACHE_TTL_MS).toISOString(),
  }));

  const batchSize = 500;
  for (let i = 0; i < rows.length; i += batchSize) {
    try {
      await supabaseAdmin
        .from('email_validation_domain_cache')
        .upsert(rows.slice(i, i + batchSize), { onConflict: 'domain' });
    } catch (err) {
      workerLog('warn', `Domain cache upsert failed (batch ${i / batchSize + 1})`, err);
    }
  }
}

// ─── Queue helpers ──────────────────────────────────────────────────────────

type QueueStatus = 'pending' | 'processing' | 'completed' | 'failed';

async function countQueue(jobId: string, status: QueueStatus): Promise<number> {
  if (!supabaseAdmin) return 0;
  try {
    const { count } = await withTimeout(
      supabaseAdmin
        .from('email_validation_queue')
        .select('id', { count: 'exact', head: true })
        .eq('job_id', jobId)
        .eq('status', status),
      'Таймаут countQueue',
    );
    return count ?? 0;
  } catch { return 0; }
}

const EMPTY_BATCH_POLL_MS = 600;
// Кэп сна до ближайшего retry_after: дольше — задержали бы проверку отмены
// джоба и сброс зависших processing-строк.
const RETRY_WAIT_CAP_MS = 60_000;
// Кэп хвоста джоба: когда вся активная работа сделана и остались только
// отложенные ретраи, джоб НЕ ждёт их дольше этого времени — оставшиеся строки
// финализируются текущим вердиктом (он сохраняется при каждом рекьюе).
// Иначе хвост из greylist 5/15/30 мин держит джоб «running» на 89% почти час
// (инцидент 2026-07-25: 445 строк, 51 deferred → 50+ мин wall-clock).
// Дефолт 25 мин покрывает greylist-расписание (пробы на 0/5/20 мин) и клэмп
// hint-подсказок (20 мин × джиттер 1.1 = 22 мин < 25). Флор 5 мин — защита
// от EMAIL_VALIDATION_TAIL_CAP_MIN=0, который убил бы все ретраи мгновенно.
// NaN-вход ('abc' и т.п.) без гарда дал бы NaN-кап = тихое ОТКЛЮЧЕНИЕ кэпа.
const TAIL_CAP_MINUTES_PARSED = Number(process.env.EMAIL_VALIDATION_TAIL_CAP_MIN ?? '25');
export const TAIL_CAP_MS = Math.max(
  5,
  Number.isFinite(TAIL_CAP_MINUTES_PARSED) && TAIL_CAP_MINUTES_PARSED > 0 ? TAIL_CAP_MINUTES_PARSED : 25,
) * 60_000;

/**
 * Миллисекунды до ближайшего отложенного ретрая джоба (один дешёвый запрос).
 * Нет отложенных — возвращаем обычный poll-интервал.
 */
async function msUntilNextRetry(jobId: string): Promise<number> {
  if (!supabaseAdmin) return EMPTY_BATCH_POLL_MS;
  try {
    const { data } = await withTimeout(
      supabaseAdmin
        .from('email_validation_queue')
        .select('retry_after')
        .eq('job_id', jobId)
        .eq('status', 'pending')
        .not('retry_after', 'is', null)
        .gt('retry_after', new Date().toISOString())
        .order('retry_after', { ascending: true })
        .limit(1),
      'Таймаут msUntilNextRetry',
    );
    const next = (data?.[0] as { retry_after?: string } | undefined)?.retry_after;
    if (!next) return EMPTY_BATCH_POLL_MS;
    const ms = new Date(next).getTime() - Date.now();
    return Math.min(Math.max(ms, EMPTY_BATCH_POLL_MS), RETRY_WAIT_CAP_MS);
  } catch {
    return EMPTY_BATCH_POLL_MS;
  }
}

// ─── Таксономия ретраев ─────────────────────────────────────────────────────

/** Класс ретрая — определяет расписание задержки retry_after. */
export type RetryClass = 'greylist' | 'dns' | 'transport' | 'proxy';

// Расписания задержек по классам (минуты, индекс = номеру попытки; за пределами
// списка берётся последнее значение).
const GREYLIST_SCHEDULE_MIN = [5, 15, 30];
const DNS_SCHEDULE_MIN = [5, 15];
const TRANSPORT_SCHEDULE_MIN = [2, 10];
const PROXY_SCHEDULE_MIN = [1, 5];
// Клэмп подсказки «try again in N …» из SMTP-текста. Верхний предел — 20 мин,
// а не 45: hinted-ретрай должен успеть сработать ДО таймаута хвоста джоба
// (TAIL_CAP, дефолт 25 мин, см. ниже) с учётом джиттера ×1.1 — иначе ретрай
// будет финализирован таймаутом раньше, чем наступит его время.
const GREYLIST_HINT_MIN_MS = 60_000;
export const GREYLIST_HINT_MAX_MS = 20 * 60_000;

/** Парсим «try again in N seconds/minutes» из текста SMTP-ответа (greylist). */
export function parseGreylistHintMs(smtpText: string | undefined): number | null {
  if (!smtpText) return null;
  const m = /try again in\s+(\d+)\s*(seconds?|secs?|minutes?|mins?)/i.exec(smtpText);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return /^min/i.test(m[2]) ? n * 60_000 : n * 1000;
}

const PROXY_ERROR_RE = /prox|fetch failed|aborted/i;
const TRANSPORT_ERROR_RE = /timeout|etimedout|econnreset|econnrefused|ehostunreach|enetunreach/i;

/**
 * Классификатор ретрая: в первую очередь по структурированным полям
 * (details.step + smtp_text), для старых строк без details и исключений —
 * консервативный фолбэк по тексту ошибки. null = терминально, не ретраим.
 *
 * attempts — сколько попыток УЖЕ сделано (attempt_count инкрементится при claim,
 * т.е. первая обработка приходит с attempts=1).
 */
export function classifyRetry(
  error: string | undefined,
  details: Record<string, unknown> | undefined,
  attempts: number,
): RetryClass | null {
  if (attempts >= MAX_ATTEMPTS) return null;

  const step = typeof details?.step === 'string' ? details.step : null;

  // over_quota — лимит проверок исчерпан: терминально, НЕ ретраим.
  if (step === 'over_quota') return null;
  // smtp_5xx_policy — анти-проба/рейт-лимит на RCPT: ТЕРМИНАЛЬНО. Продовая
  // выборка (33/69 — Backscatter Protection, relay-denied, sender-rep) — это
  // постоянные отказы: отложенная попытка через 45 мин не конвертирует, но
  // держит весь джоб заложником хвоста (инцидент 2026-07-25: джоб 445 строк
  // висел 50+ мин на 89%). Честный unknown сразу лучше позднего такого же.
  if (step === 'smtp_5xx_policy') return null;

  if (step === 'greylist') return 'greylist';
  if (step === 'mx') {
    // Только транзиентный DNS-сбой (MX undetermined); «нет MX» — терминальный
    // invalid и сюда не доходит, но на всякий случай проверяем текст.
    const mxErr = `${error ?? ''} ${String(details?.error ?? '')}`;
    return /dns/i.test(mxErr) ? 'dns' : null;
  }
  // Ни один MX не ответил на connect / catch-all проба временно сбойнула.
  if (step === 'smtp' || step === 'catch_all_undetermined') return 'transport';
  // Прокси упал/перезапускается — короткий ретрай независимо от шага.
  if (PROXY_ERROR_RE.test(error ?? '')) return 'proxy';

  // ── Фолбэк по тексту ошибки (старые строки без details, исключения) ──
  const lower = (error ?? '').toLowerCase();
  if (!lower) return null;
  if (lower.includes('greylist') || lower.includes('временн')) return 'greylist';
  if (/\b45[01]\b/.test(lower) || lower.includes('4.7.1')) return 'greylist';
  if (lower.includes('dns lookup failed')) return 'dns';
  if (TRANSPORT_ERROR_RE.test(lower)) return 'transport';
  return null;
}

export function shouldRetry(
  error: string | undefined,
  attempts: number,
  details?: Record<string, unknown>,
): boolean {
  return classifyRetry(error, details, attempts) !== null;
}

function pickScheduleMin(schedule: number[], attempts: number): number {
  return schedule[Math.min(Math.max(attempts - 1, 0), schedule.length - 1)];
}

// ±10% джиттер, чтобы отложенные ретраи не выстроились в одну секунду.
function withJitter(ms: number): number {
  return Math.round(ms * (0.9 + Math.random() * 0.2));
}

/**
 * Задержка retry_after для класса ретрая с эскалацией по номеру попытки.
 * Для greylist сначала пробуем подсказку «try again in N» из smtp_text
 * (клэмп [1 мин, 20 мин] — верх подобран под TAIL_CAP, см. выше); без неё —
 * расписание 5→15→30 мин.
 */
export function retryDelayMs(cls: RetryClass, attempts: number, smtpText?: string): number {
  let base: number;
  if (cls === 'greylist') {
    const hint = parseGreylistHintMs(smtpText);
    base = hint !== null
      ? Math.min(Math.max(hint, GREYLIST_HINT_MIN_MS), GREYLIST_HINT_MAX_MS)
      : pickScheduleMin(GREYLIST_SCHEDULE_MIN, attempts) * 60_000;
  } else if (cls === 'dns') {
    base = pickScheduleMin(DNS_SCHEDULE_MIN, attempts) * 60_000;
  } else if (cls === 'transport') {
    base = pickScheduleMin(TRANSPORT_SCHEDULE_MIN, attempts) * 60_000;
  } else if (cls === 'proxy') {
    base = pickScheduleMin(PROXY_SCHEDULE_MIN, attempts) * 60_000;
  } else {
    // exhaustive: RetryClass покрыт ветками выше
    base = TRANSPORT_SCHEDULE_MIN[0] * 60_000;
  }
  return withJitter(base);
}

// ─── Main worker function ───────────────────────────────────────────────────

/**
 * Контекст единого жизненного цикла задач (app/src/lib/jobs/lifecycle.ts).
 *
 * Необязателен — но НЕ потому, что есть второй вызывающий: с 03.09.2026 тело
 * зовёт только `worker/emailvalidation.ts`, а вызов из монолитного
 * `worker/index.ts` убран тем же коммитом, что и перевод на аренду. Параметр
 * оставлен опциональным, чтобы функция оставалась вызываемой сама по себе — из
 * скрипта, разбора инцидента или будущего вызывающего, — и чтобы это не
 * требовало городить фиктивный контекст. Без него нет ни ограждения жетоном, ни
 * прерываемых пауз: такой прогон обязан быть единственным.
 */
export interface EmailValidationRunContext {
  /** Взводится на SIGTERM воркера и при потере аренды. */
  signal: AbortSignal;
  /**
   * Жетон текущего захвата. Им ограждаются ВСЕ записи в строку
   * email_validation_jobs: терминальный статус тут пишет само тело
   * (manageTerminalStatus: false), и без жетона старый исполнитель после
   * перехвата задачи проштамповал бы completed/failed поверх работы нового.
   */
  runToken: string;
  /** false — задачу перехватили: прекратить работу. */
  saveCheckpoint(data: { processed: number }): Promise<boolean>;
}

/**
 * Чекпойнт пишем не чаще раза в столько.
 *
 * Настоящее возобновление у этой очереди считается не из чекпойнта, а из
 * построчной очереди (email_validation_queue): новый владелец берёт только
 * строки со статусом pending, уже проверенные не переигрываются. Чекпойнт
 * нужен ради двух побочных эффектов библиотеки — он продлевает аренду и
 * обнуляет бюджет неудач (attempts), а его ответ ещё и самый дешёвый способ
 * узнать, что строку перехватили.
 */
const CHECKPOINT_MIN_INTERVAL_MS = 30_000;

export async function runEmailValidationJob(jobId: string, ctx?: EmailValidationRunContext) {
  if (!supabaseAdmin) {
    await logError('email.validation.worker.no_admin', new Error('supabaseAdmin is not configured'));
    return;
  }

  const db = supabaseAdmin;
  let trace: Span | null = null;
  const runToken = ctx?.runToken ?? null;

  /**
   * Работа прервана извне: остановка воркера (SIGTERM) или потерянная аренда.
   *
   * Это НЕ итог задачи. Строка обязана остаться в running: аренду отпустит
   * библиотека, соседняя реплика подберёт задачу и продолжит с построчной
   * очереди. Любая терминальная запись здесь (completed/failed/cancelled)
   * стоила бы уже сделанной работы, поэтому флаг проверяется и после цикла, и
   * в общем catch. Решение принимается по signal.aborted, а НЕ по имени
   * ошибки: настоящий таймаут обязан остаться отказом.
   */
  let interrupted = false;

  /**
   * Все записи в строку задачи идут через один ограждённый жетоном путь.
   * Вызов без ctx (см. EmailValidationRunContext) жетона не имеет, и фильтр
   * тогда не добавляется — такой прогон обязан быть единственным.
   *
   * Исключение ровно одно и оно ниже: терминальная запись ОТМЕНЁННОЙ задачи.
   * Отмену пишет роут, и он же снимает владение — жетона на строке к этому
   * моменту уже нет, и ограждение по нему било бы мимо.
   */
  // Тип билдера — any по той же причине, что в lib/jobs/lifecycle.ts: цепочка
  // PostgREST меняет форму на каждом шаге, а нам нужен от неё только .eq.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fenced = <T>(q: T): T => (runToken ? ((q as any).eq('run_token', runToken) as T) : q);
  const updateJob = (patch: Record<string, unknown>) =>
    fenced(db.from('email_validation_jobs').update(patch).eq('id', jobId));

  try {
    workerLog('info', `Starting job ${jobId}`);

    const { data: job, error: jobError } = await db
      .from('email_validation_jobs')
      .select('id, user_id, status, total, processed, success_count, error_count')
      .eq('id', jobId)
      .single<JobRow>();

    if (jobError || !job) {
      workerLog('error', `Job not found: ${jobId}`, jobError);
      await logError('email.validation.worker.job_not_found', jobError ?? new Error('Job not found'), { jobId });
      return;
    }

    if (['failed', 'cancelled'].includes(job.status)) return;

    trace = await startTrace({
      name: 'database.email_validation',
      input: { jobId, total: job.total },
      message: `Валидация почт (${job.total} адресов)`,
      userId: job.user_id,
      jobId,
    });

    let processed = job.processed ?? 0;
    let success = job.success_count ?? 0;
    let errors = job.error_count ?? 0;

    // Resume handling
    if (job.status === 'completed') {
      const [pendingCount, processingCount, completedCount, failedCount] = await Promise.all([
        countQueue(jobId, 'pending'),
        countQueue(jobId, 'processing'),
        countQueue(jobId, 'completed'),
        countQueue(jobId, 'failed'),
      ]);
      if (pendingCount === 0 && processingCount === 0) return;
      processed = completedCount + failedCount;
      success = completedCount;
      errors = failedCount;
      await updateJob({ status: 'running', completed_at: null });
    }

    // Под механизмом задач сюда не попадаем: строку в running переводит сам
    // захват (lib/jobs/lifecycle.ts), started_at ставит его claimPatch. Ветка
    // осталась не ради второго вызывающего (его нет, см.
    // EmailValidationRunContext), а как собственная предусловие-обработка
    // функции: вызванная без ctx, она обязана сама довести строку до running.
    if (job.status === 'pending') {
      await updateJob({ status: 'running', started_at: new Date().toISOString() });
    }

    let cancelled = false;

    // Reset stale processing items
    await db.rpc('reset_stale_email_validation_items', {
      p_job_id: jobId,
      p_minutes: STALE_PROCESSING_MINUTES,
    });

    // Load domain cache (только домены этого джоба + снапшот для dirty-upsert'а)
    const jobDomains = await loadJobDomains(jobId);
    const { cache: domainCache, snapshot: domainCacheSnapshot } = await loadDomainCache(jobId, jobDomains);
    let lastProgressFlush = Date.now();

    // Periodic progress flush to avoid hammering DB
    const flushProgress = async () => {
      const now = Date.now();
      if (now - lastProgressFlush < JOB_PROGRESS_FLUSH_INTERVAL) return;
      lastProgressFlush = now;
      await updateJob({ processed, success_count: success, error_count: errors });
    };

    /**
     * Чекпойнт после реально сделанной пачки, не чаще раза в
     * CHECKPOINT_MIN_INTERVAL_MS. Возвращает false, если задачу перехватили.
     *
     * Намеренно НЕ зовётся в хвосте отложенных ретраев: там работа не идёт, и
     * обнулять бюджет попыток нечем — иначе воркер, падающий по кругу, никогда
     * не дошёл бы до предела. Живость строки в хвосте держит продление аренды,
     * а перехват заметит либо оно, либо проверка signal в начале круга.
     */
    let lastCheckpointAt = Date.now();
    const checkpointAfterBatch = async (): Promise<boolean> => {
      if (!ctx) return true;
      const nowMs = Date.now();
      if (nowMs - lastCheckpointAt < CHECKPOINT_MIN_INTERVAL_MS) return true;
      lastCheckpointAt = nowMs;
      return ctx.saveCheckpoint({ processed });
    };

    // ── Main processing loop ────────────────────────────────────────────
    // Таймер хвоста: стартует, когда claim впервые вернул пусто при оставшихся
    // ТОЛЬКО отложенных (pending с retry_after в будущем) — т.е. вся активная
    // работа кончилась. Сбрасывается, пока есть processing (работа в полёте).
    let tailStartedAt: number | null = null;
    while (true) {
      // Остановка воркера или потеря аренды: выходим БЕЗ терминальной записи.
      if (ctx?.signal.aborted) { interrupted = true; break; }

      // Check for cancellation
      const { data: jobStatus } = await db
        .from('email_validation_jobs')
        .select('status')
        .eq('id', jobId)
        .single<{ status: JobRow['status'] }>();
      if (jobStatus?.status === 'cancelled') { cancelled = true; break; }

      // Claim a batch of items
      const { data: items, error: claimErr } = await db.rpc('claim_email_validation_items', {
        p_job_id: jobId,
        p_limit: WORKER_BATCH_SIZE,
      });

      if (claimErr) {
        workerLog('error', `Claim failed for job ${jobId}`, claimErr);
        await logError('email.validation.worker.claim_failed', claimErr, { jobId });
        await sleep(500, ctx?.signal);
        continue;
      }

      const batch = (items as QueueItem[]) ?? [];
      if (batch.length === 0) {
        const [pendingCount, processingCount] = await Promise.all([
          countQueue(jobId, 'pending'),
          countQueue(jobId, 'processing'),
        ]);
        if (pendingCount === 0 && processingCount === 0) break;

        // Reset stale items if they exist
        if (processingCount > 0) {
          tailStartedAt = null; // работа ещё в полёте — не хвост
          await db.rpc('reset_stale_email_validation_items', {
            p_job_id: jobId,
            p_minutes: STALE_PROCESSING_MINUTES,
          });
        } else {
          // batch пуст + pending>0 + processing=0 → остались только отложенные.
          // Джоб НЕ ждёт их дольше TAIL_CAP: финализируем текущим вердиктом
          // (сохранён при рекьюе) и закрываемся — иначе хвост держит джоб
          // «running» на ~89% десятки минут.
          tailStartedAt ??= Date.now();
          if (Date.now() - tailStartedAt > TAIL_CAP_MS) {
            const finalized = await finalizeDeferredTail(jobId);
            if (finalized > 0) {
              workerLog('info', `Job ${jobId}: tail cap ${TAIL_CAP_MS / 60000}min — finalized ${finalized} deferred rows with stored verdicts`);
              break;
            }
            // 0 при ошибке UPDATE (транзиентный сбой БД): НЕ break — иначе джоб
            // закроется 'completed' с вечными pending-строками. Пробуем снова
            // на следующей итерации (таймер хвоста уже за пределами кэпа).
            workerLog('warn', `Job ${jobId}: tail cap reached but finalize failed — retrying next cycle`);
          }
        }

        // Если остались только отложенные (retry_after в будущем) — спим до
        // ближайшего, а не долбим claim каждые 600мс впустую. Сон прерываемый:
        // остановка воркера не должна ждать минуту.
        await sleep(await msUntilNextRetry(jobId), ctx?.signal);
        continue;
      }
      tailStartedAt = null; // claim вернул работу — хвост закончился

      // Process batch with concurrency
      await mapWithConcurrency(
        batch,
        Math.max(1, Math.min(WORKER_CONCURRENCY, batch.length)),
        async (item) => {
          // Задача уже не наша: оставшиеся строки пачки не трогаем вовсе.
          // Они останутся в processing и вернутся в pending по
          // reset_stale_email_validation_items у нового владельца — это лучше,
          // чем платная проба за чужой счёт и вердикт поверх его работы.
          if (ctx?.signal.aborted) return;

          const domain = item.email_normalized.split('@')[1] ?? '';
          const release = await acquireDomainSlot(domain);

          try {
            // attempt_count инкрементится при claim. Гард именно '>', НЕ '>=':
            // classifyRetry сам перестаёт рекьюить на attempts >= MAX_ATTEMPTS,
            // поэтому claim с attempt_count === MAX_ATTEMPTS — это ПОСЛЕДНЯЯ
            // реальная проба (после неё вердикт completed/unknown), а не
            // terminal-fail без пробы. Жёсткий fail здесь — только для строк,
            // которые пережили лишний claim через crash/stale-reset (те жгут
            // attempt_count без валидации): и то даём им пробу, пока счётчик
            // не превысил лимит.
            if (item.attempt_count > MAX_ATTEMPTS) {
              await updateQueueItemResult(item, null, 'failed', `Превышено число попыток (${MAX_ATTEMPTS})`);
              errors += 1;
              processed += 1;
              return;
            }

            const result = await validateEmail(item.email_normalized, domainCache, {
              signal: ctx?.signal,
            });
            // Проба прервана остановкой — её вердикт недостоверен (перебор MX
            // и прокси оборван на середине). Ничего не пишем: строка останется
            // в processing и вернётся в очередь по reset_stale.
            if (ctx?.signal.aborted) return;

            if (result.error && result.result === 'unknown') {
              const cls = classifyRetry(result.error, result.details, item.attempt_count);
              if (cls) {
                const smtpText = typeof result.details?.smtp_text === 'string'
                  ? result.details.smtp_text
                  : undefined;
                const delayMs = retryDelayMs(cls, item.attempt_count, smtpText);
                if (cls === 'greylist') {
                  workerLog('info', `Greylisting detected for ${item.email_normalized}, retry in ${Math.round(delayMs / 1000)}s`);
                }
                await requeueItem(item, delayMs, result);
                return;
              }
            }

            await updateQueueItemResult(item, result, 'completed', null);
            if (result.quality === 'bad') {
              errors += 1;
            } else {
              success += 1;
            }
            processed += 1;
          } catch (err) {
            // Исключение НА ПРЕРЫВАНИИ — не отказ строки: решаем по signal, а
            // не по тексту ошибки, чтобы настоящий таймаут остался отказом.
            if (ctx?.signal.aborted) return;
            const msg = err instanceof Error ? err.message : 'Ошибка валидации';
            const cls = classifyRetry(msg, undefined, item.attempt_count);
            if (cls) {
              await requeueItem(item, retryDelayMs(cls, item.attempt_count));
            } else {
              await updateQueueItemResult(item, null, 'failed', msg);
              errors += 1;
              processed += 1;
            }
            await logError('email.validation.worker.item_failed', err, {
              jobId, itemId: item.id, email: item.email_raw,
            });
          } finally {
            release();
          }
        },
      );

      await flushProgress();
      // Чекпойнт после реальной пачки: продлевает аренду, обнуляет бюджет
      // попыток и отвечает, наша ли ещё строка. false — задачу перехватили:
      // выходим БЕЗ терминальной записи, её допишет новый владелец.
      if (!(await checkpointAfterBatch())) { interrupted = true; break; }
      workerLog('info', `Job ${jobId}: processed=${processed}/${job.total} (batch=${batch.length}, success=${success}, errors=${errors})`);
    }

    // ── Finalization ──────────────────────────────────────────────────────

    /**
     * Отмена пользователем ВЫГЛЯДИТ как перехват — и это надо различить.
     *
     * Роут отмены пишет статус 'cancelled' напрямую, мимо механизма задач.
     * Ближайшее продление аренды делает ограждённый UPDATE с фильтром по
     * статусу 'running', не находит ни одной строки и трактует это как потерю
     * владения: библиотека взводит signal с причиной 'lease-lost', тело видит
     * прерывание и без этой проверки ушло бы «оставить строку соседу». Тогда
     * оставшиеся адреса никто не пометил бы отменёнными, счётчики не
     * пересчитались бы, а экран результатов показал бы не то, что показывал до
     * переезда на аренду. Кто успеет первым — продление (раз в минуту) или
     * проверка статуса в начале круга (раз на пачку, а пачка идёт минутами) —
     * гонка, поэтому решать по одному лишь signal нельзя.
     *
     * Перечитываем статус ОДИН раз и только на прерывании. Решение по-прежнему
     * принимается по signal, а не по имени ошибки: signal лишь отправляет нас
     * сюда, а различает отмену и настоящий перехват состояние строки в базе.
     *
     * В шаблоне поиска (worker/search.ts, этап 3) форма та же, но проблемы нет:
     * там ветка отмены ничего не убирает, и уход по пути прерывания ничего не
     * теряет. Копировать эту проверку туда не надо.
     */
    if (interrupted) {
      const { data: latest } = await db
        .from('email_validation_jobs')
        .select('status')
        .eq('id', jobId)
        .maybeSingle<{ status: JobRow['status'] }>();
      if (latest?.status === 'cancelled') {
        workerLog('info', `Job ${jobId}: прерывание оказалось отменой пользователем — доводим уборку`);
        cancelled = true;
        interrupted = false;
      }
    }

    if (interrupted) {
      // Ни completed, ни failed, ни cancelled: строка остаётся running под
      // управлением библиотеки — аренду отпустит она, задачу продолжит соседняя
      // реплика с построчной очереди. Единственный корректный выход из
      // прерывания. Счётчики дописываем ограждённой записью: они и есть
      // отпечаток прогресса, по которому монитор судит о движении задачи.
      await updateJob({ processed, success_count: success, error_count: errors });
      workerLog('info', `Job ${jobId} interrupted — left running for reclaim (processed=${processed})`);
      await logInfo('email.validation.worker.interrupted', 'Email validation job interrupted — left running for reclaim', {
        jobId, processed, success, errors,
      });
      await trace?.cancel('Остановка воркера: задача продолжится с оставшихся строк очереди.');
      return;
    }

    if (cancelled) {
      const now = new Date().toISOString();
      await db
        .from('email_validation_queue')
        .update({ status: 'failed', last_error: 'Отменено пользователем', updated_at: now, completed_at: now })
        .eq('job_id', jobId)
        .in('status', ['pending', 'processing']);
    }

    // Recount for accuracy
    const [completedCount, failedCount] = await Promise.all([
      countQueue(jobId, 'completed'),
      countQueue(jobId, 'failed'),
    ]);

    const finalStatus: JobRow['status'] = cancelled ? 'cancelled' : 'completed';
    // Терминальная запись обнуляет владение: библиотека при
    // manageTerminalStatus:false снимает осадок сама, но только после штатного
    // возврата run(). Обнуляем здесь же, чтобы дежурный запрос «кто держит
    // аренду» не показывал закрытые задачи даже в окне между двумя записями.
    const terminalPatch = {
      status: finalStatus,
      processed: completedCount + failedCount,
      success_count: completedCount,
      error_count: failedCount,
      completed_at: new Date().toISOString(),
      lease_until: null,
      run_token: null,
      worker_id: null,
    };
    if (cancelled) {
      // Единственная запись мимо жетона — и обязана быть такой. Отмену уже
      // записал роут, он же снял с этой строки владение, так что фильтра
      // .eq('run_token', …) она не пройдёт вовсе и итоговые счётчики просто не
      // легли бы. Вместо жетона ограждаемся статусом: строка уже терминальная,
      // захват её не берёт (все пути фильтруют по running), и переписать мы
      // можем только её же — а значения пересчитаны по очереди, то есть повтор
      // идемпотентен.
      await db.from('email_validation_jobs').update(terminalPatch).eq('id', jobId).eq('status', 'cancelled');
    } else {
      await updateJob(terminalPatch);
    }

    // Persist domain cache for future jobs (только изменённые за прогон записи)
    await saveDomainCache(domainCache, domainCacheSnapshot);

    workerLog('info', `Job ${jobId} FINISHED: status=${finalStatus}, completed=${completedCount}, failed=${failedCount}`);
    await logInfo('email.validation.worker.completed', 'Email validation job completed', {
      jobId, processed: completedCount + failedCount, success: completedCount, errors: failedCount,
    });
    await trace?.end({ processed: completedCount + failedCount, success: completedCount, errors: failedCount, status: finalStatus });

    await cleanupOldQueues();

  } catch (err) {
    // Исключение НА ПРЕРЫВАНИИ — не отказ задачи: прерванный запрос бросает
    // AbortError, и без этой проверки остановка воркера штамповала бы failed на
    // живой задаче, которую сосед готов продолжить. Решаем по signal.aborted, а
    // НЕ по имени/тексту ошибки: настоящий таймаут обязан остаться отказом.
    if (interrupted || ctx?.signal.aborted) {
      workerLog('info', `Job ${jobId} aborted mid-flight — left running for reclaim`);
      await logInfo('email.validation.worker.interrupted', 'Email validation job aborted mid-flight — left running for reclaim', {
        jobId, reason: err instanceof Error ? err.message : String(err),
      });
      await trace?.cancel('Остановка воркера: задача продолжится с оставшихся строк очереди.');
      return;
    }
    workerLog('error', `Job ${jobId} CRASHED`, err);
    await logError('email.validation.worker.failed', err, { jobId });
    await trace?.fail(err);
    await updateJob({
      status: 'failed',
      completed_at: new Date().toISOString(),
      error_message: err instanceof Error ? err.message : 'Worker error',
      lease_until: null,
      run_token: null,
      worker_id: null,
    });
    await cleanupOldQueues();
  }
}

// ─── Queue item update helpers ──────────────────────────────────────────────

async function updateQueueItemResult(
  item: QueueItem,
  result: ValidationResult | null,
  status: 'completed' | 'failed',
  errorMsg: string | null,
): Promise<void> {
  if (!supabaseAdmin) return;
  const now = new Date().toISOString();

  const update: Record<string, unknown> = {
    status,
    updated_at: now,
    completed_at: now,
  };

  if (result) {
    update.result = result.result;
    update.quality = result.quality;
    update.is_free = result.is_free;
    update.is_role = result.is_role;
    update.is_disposable = result.is_disposable;
    update.is_catch_all = result.is_catch_all;
    update.did_you_mean = result.did_you_mean;
    update.mx_found = result.mx_found;
    update.smtp_code = result.smtp_code;
    update.details = result.details;
    update.last_error = result.error ?? null;
  } else {
    update.last_error = errorMsg;
    update.result = 'unknown';
    update.quality = 'risky';
  }

  try {
    await withTimeout(
      supabaseAdmin.from('email_validation_queue').update(update).eq('id', item.id),
      `Таймаут обновления queue item (${item.id})`,
    );
  } catch (err) {
    await logError('email.validation.worker.queue_update_failed', err, {
      jobId: item.job_id, itemId: item.id,
    });
  }
}

/**
 * Таймаут хвоста джоба: все отложенные (pending) строки финализируются
 * текущим вердиктом (он сохранён при рекьюе). Для строк без вердикта
 * (рекью от старого кода) подставляем unknown/risky — как терминальный
 * непроверяемый исход. Возвращает число финализированных строк.
 * Счётчики джоба пересчитываются финализацией по таблице — см. конец job.
 */
async function finalizeDeferredTail(jobId: string): Promise<number> {
  if (!supabaseAdmin) return 0;
  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from('email_validation_queue')
    .update({
      status: 'completed',
      result: 'unknown',
      quality: 'risky',
      last_error: 'Хвост джоба: отложенная повторная проверка прервана по таймауту',
      updated_at: now,
      completed_at: now,
    })
    .eq('job_id', jobId)
    .eq('status', 'pending')
    .is('result', null)
    .select('id');
  if (error) {
    workerLog('warn', `finalizeDeferredTail: fallback update failed for job ${jobId}`, error);
    return 0;
  }
  const fallbackCount = data?.length ?? 0;
  // Строки с сохранённым вердиктом — просто закрываем (вердикт уже на месте).
  const { data: data2, error: error2 } = await supabaseAdmin
    .from('email_validation_queue')
    .update({ status: 'completed', updated_at: now, completed_at: now })
    .eq('job_id', jobId)
    .eq('status', 'pending')
    .not('result', 'is', null)
    .select('id');
  if (error2) {
    // 0, а не partial: первый UPDATE мог уже закрыть часть строк — вернём
    // fallbackCount, и caller сделает break с вечными pending-строками
    // (их вердикты не попадут в results и будут стёрты cleanup'ом). Оба
    // UPDATE'а идемпотентны — пусть следующая итерация повторит целиком.
    workerLog('warn', `finalizeDeferredTail: verdict update failed for job ${jobId}`, error2);
    return 0;
  }
  return fallbackCount + (data2?.length ?? 0);
}

async function requeueItem(item: QueueItem, delayMs: number, result?: ValidationResult): Promise<void> {
  if (!supabaseAdmin) return;
  try {
    const now = new Date().toISOString();
    // retry_after ставится при КАЖДОМ рекьюе: класс ретрая уже решил задержку,
    // немедленного повтора быть не должно.
    // Вердикт последней пробы сохраняем СРАЗУ (result/quality/details/last_error):
    // если хвост джоба будет финализирован по таймауту (TAIL_CAP) или воркер
    // умрёт, строка не останется «пустой» — у неё уже есть честный unknown.
    await supabaseAdmin
      .from('email_validation_queue')
      .update({
        status: 'pending',
        updated_at: now,
        retry_after: new Date(Date.now() + delayMs).toISOString(),
        ...(result
          ? {
              result: result.result,
              quality: result.quality,
              details: result.details ?? null,
              last_error: result.error ?? null,
            }
          : {}),
      })
      .eq('id', item.id);
  } catch (err) {
    workerLog('warn', `Requeue failed for ${item.email_normalized} (${item.id})`, err);
  }
}

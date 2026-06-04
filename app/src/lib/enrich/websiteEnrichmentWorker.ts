import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logError, logInfo } from '@/lib/loggerServer';
import { extractNormalizedUrls, fetchAndExtract, normalizeUrl } from '@/lib/enrich/websiteParser';
import { scrapeEmails } from '@/lib/enrich/emailScraper';
import { processSignalsForUrl } from '@/lib/enrich/websiteSignalProcessor';
import { runWithTimeout } from '@/lib/enrich/timeoutUtils';
import { shouldRetryEnrichmentItem, shouldUseCachedError } from '@/lib/enrich/errorPolicy';
import { applyEnrichmentResults } from '@/lib/spreadsheet/applyJobResults';
import { applySignalJobResults, type ExtraColumnSpec } from '@/lib/spreadsheet/applySignalJobResults';
import type { ExtractorKey } from '@/lib/enrich/extractors/types';
import { startTrace } from '@/lib/tracer';
import type { Span } from '@/lib/tracer';
import { writeEnrichResult, type EnrichBufferStatus } from '@/lib/enrich/enrichBuffer';

type QueueItem = {
  id: string;
  job_id: string;
  row_index: number;
  url_raw: string;
  url_normalized: string;
  attempt_count: number;
};

type ExtractionType = 'text' | 'email' | 'signals';

type JobRow = {
  id: string;
  user_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  extraction_type: ExtractionType;
  total: number;
  processed: number;
  success_count: number;
  error_count: number;
  spreadsheet_tab_id: string | null;
  result_col_index: number | null;
  result_col_header: string | null;
  result_col_index_2: number | null;
  result_col_header_2: string | null;
  extractors: string[] | null;
  extra_cols: unknown;
};

function parseExtraCols(value: unknown): ExtraColumnSpec[] | undefined {
  if (!value || !Array.isArray(value)) return undefined;
  const out: ExtraColumnSpec[] = [];
  for (const entry of value) {
    if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as { key?: unknown }).key === 'string' &&
      typeof (entry as { colIndex?: unknown }).colIndex === 'number' &&
      typeof (entry as { header?: unknown }).header === 'string'
    ) {
      out.push(entry as ExtraColumnSpec);
    }
  }
  return out.length > 0 ? out : undefined;
}

function parseExtractors(value: unknown): ExtractorKey[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const filtered = value.filter((v): v is string => typeof v === 'string');
  return filtered.length > 0 ? (filtered as ExtractorKey[]) : undefined;
}

type FetchResult = { text?: string; error?: string };

const WORKER_CONCURRENCY = Number(process.env.WEBSITE_ENRICHMENT_CONCURRENCY ?? '25');
const WORKER_BATCH_SIZE = Number(process.env.WEBSITE_ENRICHMENT_BATCH_SIZE ?? '60');
const CACHE_SUCCESS_DAYS = Number(process.env.WEBSITE_ENRICHMENT_CACHE_DAYS ?? '7');
const CACHE_ERROR_HOURS = Number(process.env.WEBSITE_ENRICHMENT_ERROR_TTL_HOURS ?? '6');
const DOMAIN_CONCURRENCY = Number(process.env.WEBSITE_ENRICHMENT_DOMAIN_CONCURRENCY ?? '1');
const FETCH_TIMEOUT_MS = Number(process.env.WEBSITE_ENRICHMENT_TIMEOUT_MS ?? '15000');
const FETCH_HARD_TIMEOUT_MS = Number(
  process.env.WEBSITE_ENRICHMENT_HARD_TIMEOUT_MS ?? String(Math.max(FETCH_TIMEOUT_MS * 4, 60000)),
);
const STALE_PROCESSING_MINUTES = Number(process.env.WEBSITE_ENRICHMENT_STALE_MINUTES ?? '3');
const MAX_ATTEMPTS = Number(process.env.WEBSITE_ENRICHMENT_MAX_ATTEMPTS ?? '3');
const SUPABASE_QUERY_TIMEOUT_MS = Number(process.env.WEBSITE_ENRICHMENT_DB_TIMEOUT_MS ?? '30000');
const EMAIL_CACHE_WRITE_BACKOFF_MS = Number(process.env.WEBSITE_ENRICHMENT_EMAIL_CACHE_BACKOFF_MS ?? '15000');

const cacheSuccessTtlMs = CACHE_SUCCESS_DAYS * 24 * 60 * 60 * 1000;
const cacheErrorTtlMs = CACHE_ERROR_HOURS * 60 * 60 * 1000;
const staleProcessingMs = STALE_PROCESSING_MINUTES * 60 * 1000;
let emailCacheWritesPausedUntil = 0;
let lastEmailCacheWriteErrorAt = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function withSupabaseTimeout<T>(operation: PromiseLike<T>, timeoutMessage: string): Promise<T> {
  return runWithTimeout(Promise.resolve(operation), {
    timeoutMs: SUPABASE_QUERY_TIMEOUT_MS,
    timeoutMessage,
  });
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await worker(items[current], current);
    }
  };

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runWorker());
  await Promise.all(workers);
  return results;
}

function normalizeDomain(raw: string) {
  try {
    const url = normalizeUrl(raw);
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

type ReleaseFn = () => void;

const domainActive = new Map<string, number>();
const domainQueue = new Map<string, Array<() => void>>();

async function acquireDomainSlot(domain: string): Promise<ReleaseFn> {
  if (!domain || DOMAIN_CONCURRENCY <= 0) return () => {};
  const current = domainActive.get(domain) ?? 0;
  if (current >= DOMAIN_CONCURRENCY) {
    await new Promise<void>((resolve) => {
      const queue = domainQueue.get(domain) ?? [];
      queue.push(resolve);
      domainQueue.set(domain, queue);
    });
  }
  domainActive.set(domain, (domainActive.get(domain) ?? 0) + 1);
  return () => {
    const next = (domainActive.get(domain) ?? 1) - 1;
    if (next <= 0) domainActive.delete(domain);
    else domainActive.set(domain, next);
    const queue = domainQueue.get(domain);
    const resolver = queue?.shift();
    if (resolver) resolver();
  };
}

type QueueStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'skipped';

async function countQueue(jobId: string, status: QueueStatus): Promise<number> {
  if (!supabaseAdmin) return 0;
  try {
    const { count, error } = await withSupabaseTimeout(
      supabaseAdmin
        .from('website_enrichment_queue')
        .select('id', { count: 'exact', head: true })
        .eq('job_id', jobId)
        .eq('status', status),
      'Таймаут запроса countQueue',
    );
    if (error) return 0;
    return count ?? 0;
  } catch {
    return 0;
  }
}

async function getOldestProcessingUpdatedAt(jobId: string): Promise<Date | null> {
  if (!supabaseAdmin) return null;
  try {
    const { data } = await withSupabaseTimeout(
      supabaseAdmin
        .from('website_enrichment_queue')
        .select('updated_at')
        .eq('job_id', jobId)
        .eq('status', 'processing')
        .order('updated_at', { ascending: true })
        .limit(1)
        .maybeSingle<{ updated_at?: string | null }>(),
      'Таймаут запроса oldest processing',
    );
    if (!data?.updated_at) return null;
    const parsed = new Date(data.updated_at);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  } catch {
    return null;
  }
}

async function getCache(urlNormalized: string) {
  if (!supabaseAdmin) return null;
  try {
    const { data, error } = await withSupabaseTimeout(
      supabaseAdmin
        .from('website_enrichment_cache')
        .select('text, last_error, expires_at')
        .eq('url_normalized', urlNormalized)
        .maybeSingle(),
      'Таймаут чтения кэша сайта',
    );
    if (error) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * No-op заглушка: cache-upsert делает enrich-coordinator в составе batch'а
 * вместе с UPDATE queue.status (см. lib/enrich/enrichBuffer.ts → planFlush).
 * Scraper кладёт cache-payload в одну строку buffer'а через writeEnrichResult
 * в updateQueueItem ниже. Функция оставлена сигнатурно совместимой потому что
 * вызывается из fetchWithCache как side-effect — пропуск записи безвреден:
 * cache HIT обновится при следующем успешном обходе через coordinator.
 */
async function setCache(_urlNormalized: string, _payload: { text?: string; error?: string; sourceUrl?: string }): Promise<void> {
  return;
}
void cacheSuccessTtlMs; void cacheErrorTtlMs; // больше не используются здесь, оставлены для legacy-кеш-helper'ов ниже

// ── Email scraper cache (separate table) ──────────────────────

async function getEmailCache(urlNormalized: string) {
  if (!supabaseAdmin) return null;
  try {
    const { data, error } = await withSupabaseTimeout(
      supabaseAdmin
        .from('email_scraper_cache')
        .select('emails, last_error, expires_at')
        .eq('url_normalized', urlNormalized)
        .maybeSingle(),
      'Таймаут чтения email-кэша',
    );
    if (error) return null;
    return data;
  } catch {
    return null;
  }
}

async function setEmailCache(
  urlNormalized: string,
  payload: { emails?: string; error?: string; sourceUrl?: string; pagesScanned?: number },
) {
  if (!supabaseAdmin) return;
  if (Date.now() < emailCacheWritesPausedUntil) return;
  const now = new Date();
  const hasEmails = payload.emails && payload.emails.length > 0;
  const expiresAt = hasEmails
    ? new Date(now.getTime() + cacheSuccessTtlMs)
    : new Date(now.getTime() + cacheErrorTtlMs);

  try {
    await withSupabaseTimeout(
      supabaseAdmin
        .from('email_scraper_cache')
        .upsert(
          {
            url_normalized: urlNormalized,
            emails: payload.emails ?? null,
            last_error: payload.error ?? null,
            fetched_at: now.toISOString(),
            expires_at: expiresAt.toISOString(),
            source_url: payload.sourceUrl ?? null,
            pages_scanned: payload.pagesScanned ?? 0,
          },
          { onConflict: 'url_normalized' },
        ),
      'Таймаут записи email-кэша',
    );
    emailCacheWritesPausedUntil = 0;
  } catch {
    // Cache write should not break item processing and must not flood PostgREST on degradation.
    emailCacheWritesPausedUntil = Date.now() + EMAIL_CACHE_WRITE_BACKOFF_MS;
    if (Date.now() - lastEmailCacheWriteErrorAt > EMAIL_CACHE_WRITE_BACKOFF_MS) {
      lastEmailCacheWriteErrorAt = Date.now();
      await logError('website.enrichment.worker.email_cache_write_failed', new Error('email cache write failed'));
    }
  }
}

function parseEmailList(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[;,\n]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function mergeUniqueEmails(values: Array<string | null | undefined>, limit = 10): string[] {
  const unique = new Map<string, string>();
  for (const value of values) {
    for (const email of parseEmailList(value)) {
      const key = email.toLowerCase();
      if (unique.has(key)) continue;
      unique.set(key, email);
      if (unique.size >= limit) {
        return Array.from(unique.values());
      }
    }
  }
  return Array.from(unique.values());
}

async function fetchEmailsForUrl(
  normalizedUrl: string,
  inflight: Map<string, Promise<FetchResult>>,
): Promise<FetchResult> {
  const key = `email:${normalizedUrl}`;
  if (inflight.has(key)) return inflight.get(key)!;

  const promise = (async () => {
    const cached = await getEmailCache(normalizedUrl);
    if (cached && cached.expires_at && new Date(cached.expires_at).getTime() > Date.now()) {
      if (cached.last_error && !cached.emails && shouldUseCachedError(cached.last_error)) {
        return { error: cached.last_error };
      }
      return { text: cached.emails ?? '' };
    }

    try {
      const abortController = new AbortController();
      const result = await runWithTimeout(
        scrapeEmails(normalizedUrl, {
          timeout: FETCH_TIMEOUT_MS,
          signal: abortController.signal,
        }),
        {
          timeoutMs: FETCH_HARD_TIMEOUT_MS,
          timeoutMessage: `Превышено время ожидания сайта (${Math.round(FETCH_HARD_TIMEOUT_MS / 1000)}с)`,
          onTimeout: () => abortController.abort(),
        },
      );
      const emailsText = result.emails.slice(0, 10).join('; ');
      await setEmailCache(normalizedUrl, {
        emails: emailsText,
        sourceUrl: normalizedUrl,
        pagesScanned: result.pagesScanned,
      });
      return { text: emailsText };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Ошибка извлечения email';
      if (shouldUseCachedError(message)) {
        await setEmailCache(normalizedUrl, { error: message, sourceUrl: normalizedUrl });
      }
      return { error: message };
    }
  })();

  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

/**
 * Signal detection: in-memory dedup only (no cross-job DB cache).
 * Worker writes JSON of full ExtractedData (stack/profile + any per-extractor
 * fields) into queue.result_text. Applier parses this and writes to the
 * configured spreadsheet columns. Backward compat: when extractors is omitted,
 * default behavior (only stack/profile) is preserved.
 *
 * Dedup key includes the extractors set so two jobs requesting different
 * extractors for the same URL don't share a cached result.
 */
async function fetchSignalsForUrl(
  item: QueueItem,
  inflight: Map<string, Promise<FetchResult>>,
  extractors?: ExtractorKey[],
): Promise<FetchResult> {
  const extractorsKeyPart = extractors && extractors.length > 0
    ? `:${[...extractors].sort().join(',')}`
    : '';
  const key = `signals:${item.url_normalized || item.url_raw}${extractorsKeyPart}`;
  if (inflight.has(key)) return inflight.get(key)!;

  const promise = (async () => {
    try {
      const abortController = new AbortController();
      const result = await runWithTimeout(
        processSignalsForUrl(item.url_raw, {
          timeout: FETCH_TIMEOUT_MS,
          signal: abortController.signal,
          extractors,
        }),
        {
          timeoutMs: FETCH_HARD_TIMEOUT_MS,
          timeoutMessage: `Превышено время ожидания сайта (${Math.round(FETCH_HARD_TIMEOUT_MS / 1000)}с)`,
          onTimeout: () => abortController.abort(),
        },
      );
      if ('error' in result) {
        return { error: result.error };
      }
      // Persist all extractor-produced fields. Drop bulky/internal-only ones
      // (signalIds is informational and method is debug metadata).
      const { signalIds: _signalIds, method: _method, ...persisted } = result;
      void _signalIds;
      void _method;
      return { text: JSON.stringify(persisted) };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Ошибка анализа сигналов';
      return { error: message };
    }
  })();

  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

/**
 * Hard timeout на ОДНУ ОЧЕРЕДНУЮ строку в email-режиме.
 *
 * Зачем: одна строка из CSV может содержать URL `extractNormalizedUrls`
 * который вернёт 1-3 вариантов (`acme.com` + `www.acme.com` + `m.acme.com`).
 * На каждый из них зовётся `fetchEmailsForUrl` → `scrapeEmails` → ходит
 * до 12 страниц с per-request таймаутом 15s. Уже-существующий
 * `FETCH_HARD_TIMEOUT_MS` (60s) — это hard cap НА ОДИН scrapeEmails вызов,
 * не на всю строку. В worst case строка может занять 60s × 3 = 3 минуты.
 *
 * Наблюдение из локального replay (26 мая): процесс зависал на 408-й
 * строке потому что все 5 concurrent слотов одновременно зацепили
 * медленные сайты, каждый сидел до 3 минут — общий темп упал в ноль.
 * На проде с concurrency=15 один patological сайт парализует один слот,
 * пять штук — треть мощности воркера.
 *
 * 120 секунд достаточно для адекватных сайтов (даже tarpit с 15s ответом
 * × 8 candidate-страниц = 120s), но отрезает явный мусор который никогда
 * не отдаёт результат.
 */
const FETCH_EMAIL_ROW_HARD_TIMEOUT_MS = Number(
  process.env.WEBSITE_ENRICHMENT_ROW_HARD_TIMEOUT_MS ?? '120000',
);

async function fetchEmailsWithCacheInner(
  item: QueueItem,
  inflight: Map<string, Promise<FetchResult>>,
): Promise<FetchResult> {
  let targets: string[];
  try {
    targets = extractNormalizedUrls(item.url_raw);
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Невалидный URL' };
  }
  if (targets.length === 0) {
    return { error: 'Пустой URL' };
  }

  const collectedTexts: string[] = [];
  const errors = new Set<string>();

  for (const normalizedUrl of targets) {
    const result = await fetchEmailsForUrl(normalizedUrl, inflight);
    if (result.text) {
      collectedTexts.push(result.text);
      continue;
    }
    if (result.error) {
      errors.add(result.error);
    }
  }

  const mergedEmails = mergeUniqueEmails(collectedTexts, 10);
  if (mergedEmails.length > 0) {
    return { text: mergedEmails.join('; ') };
  }

  if (errors.size > 0) {
    const [firstError] = Array.from(errors);
    return { error: errors.size > 1 ? `${firstError} (и ещё ${errors.size - 1})` : firstError };
  }

  return { text: '' };
}

async function fetchEmailsWithCache(
  item: QueueItem,
  inflight: Map<string, Promise<FetchResult>>,
): Promise<FetchResult> {
  try {
    return await runWithTimeout(fetchEmailsWithCacheInner(item, inflight), {
      timeoutMs: FETCH_EMAIL_ROW_HARD_TIMEOUT_MS,
      timeoutMessage: `Превышен per-row таймаут ${FETCH_EMAIL_ROW_HARD_TIMEOUT_MS / 1000}s`,
    });
  } catch (err) {
    // runWithTimeout reject'ит с Error(timeoutMessage); поведение
    // соответствует прочим non-success возвратам — пишем в last_error.
    // shouldRetryEnrichmentItem решит, ретраить или сразу failed.
    return { error: err instanceof Error ? err.message : 'Per-row timeout' };
  }
}

async function updateQueueItem(
  item: QueueItem,
  result: FetchResult,
  status: 'pending' | 'completed' | 'failed' | 'skipped',
): Promise<boolean> {
  if (!supabaseAdmin) return false;

  // Coordinator pattern: terminal-статусы (completed/failed/skipped) идут
  // в `website_enrichment_results_buffer` одной строкой; coordinator batch'ит
  // их и flush'ит в queue/cache/jobs (см. enrichBuffer.ts).
  //
  // Status='pending' (retry) — единственный путь, который остаётся direct
  // UPDATE'ом: scraper должен сразу вернуть item обратно в очередь, иначе
  // claim_website_enrichment_items не подхватит его снова в этом же цикле.
  // Retry — мгновенный UPDATE по PK, нагрузку он не создаёт (≤MAX_ATTEMPTS=3
  // раз на item за весь job).
  if (status !== 'pending') {
    const bufStatus: EnrichBufferStatus = status;
    const r = await writeEnrichResult(supabaseAdmin, {
      queue_id: item.id,
      job_id: item.job_id,
      status: bufStatus,
      result_text: status === 'completed' ? result.text ?? null : null,
      last_error: status === 'completed' ? null : result.error ?? null,
      // Cache-payload летит coordinator'у в составе этой же buffer-строки —
      // он сделает UPSERT в website_enrichment_cache одним batch-запросом
      // вместо отдельной записи на каждый URL.
      cache_url_normalized: item.url_normalized || null,
      cache_source_url: item.url_raw || null,
      attempt_count: item.attempt_count,
    });
    if (!r.ok) {
      await logError(
        'website.enrichment.worker.buffer_write_failed',
        new Error(r.error),
        { jobId: item.job_id, itemId: item.id, status },
      );
      return false;
    }
    return true;
  }

  // Сюда попадает только status='pending' (retry-путь): scraper возвращает
  // item в очередь, чтобы его подобрала следующая claim-итерация. Поля
  // result_text/completed_at нулим напрямую, без ветвлений по status — это
  // тот же UPDATE что был в legacy-ветке для pending, но без мёртвых
  // тернарных проверок (TS их теперь видит как unreachable).
  const now = new Date().toISOString();
  try {
    const { error } = await withSupabaseTimeout(
      supabaseAdmin
        .from('website_enrichment_queue')
        .update({
          status: 'pending',
          result_text: null,
          last_error: result.error ?? null,
          updated_at: now,
          completed_at: null,
        })
        .eq('id', item.id),
      `Таймаут обновления queue item (${item.id})`,
    );

    if (error) {
      await logError('website.enrichment.worker.queue_update_failed', error, {
        jobId: item.job_id,
        rowIndex: item.row_index,
        itemId: item.id,
        status,
      });
      return false;
    }

    return true;
  } catch (error) {
    await logError('website.enrichment.worker.queue_update_timeout', error, {
      jobId: item.job_id,
      rowIndex: item.row_index,
      itemId: item.id,
      status,
    });
    return false;
  }
}

async function fetchWithCache(item: QueueItem, inflight: Map<string, Promise<FetchResult>>): Promise<FetchResult> {
  const key = item.url_normalized;
  if (key && inflight.has(key)) return inflight.get(key)!;

  const promise = (async () => {
    if (key) {
      const cached = await getCache(key);
      if (cached && cached.expires_at && new Date(cached.expires_at).getTime() > Date.now()) {
        if (cached.last_error && !cached.text && shouldUseCachedError(cached.last_error)) {
          return { error: cached.last_error };
        }
        return { text: cached.text ?? '' };
      }
    }

    try {
      const abortController = new AbortController();
      const text = await runWithTimeout(
        fetchAndExtract(item.url_raw, {
          timeout: FETCH_TIMEOUT_MS,
          signal: abortController.signal,
        }),
        {
          timeoutMs: FETCH_HARD_TIMEOUT_MS,
          timeoutMessage: `Превышено время ожидания сайта (${Math.round(FETCH_HARD_TIMEOUT_MS / 1000)}с)`,
          onTimeout: () => abortController.abort(),
        },
      );
      if (key) await setCache(key, { text, sourceUrl: item.url_raw });
      return { text };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Ошибка обогащения';
      if (key && shouldUseCachedError(message)) {
        await setCache(key, { error: message, sourceUrl: item.url_raw });
      }
      return { error: message };
    }
  })();

  if (key) inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    if (key) inflight.delete(key);
  }
}

export async function runWebsiteEnrichmentJob(jobId: string) {
  if (!supabaseAdmin) {
    await logError('website.enrichment.worker.no_admin', new Error('supabaseAdmin is not configured'));
    return;
  }

  let trace: Span | null = null;
  try {
    const { data: job, error: jobError } = await supabaseAdmin
      .from('website_enrichment_jobs')
      .select('id, user_id, status, extraction_type, total, processed, success_count, error_count, spreadsheet_tab_id, result_col_index, result_col_header, result_col_index_2, result_col_header_2, extractors, extra_cols')
      .eq('id', jobId)
      .single<JobRow>();

    if (jobError || !job) {
      await logError('website.enrichment.worker.job_not_found', jobError ?? new Error('Job not found'), { jobId });
      return;
    }

    if (['failed', 'cancelled'].includes(job.status)) return;

    const isEmail = job.extraction_type === 'email';
    const isSignals = job.extraction_type === 'signals';
    const traceName = isSignals
      ? 'database.website_signals'
      : isEmail
        ? 'database.email_scraping'
        : 'database.website_enrichment';
    const traceMessage = isSignals
      ? `Анализ сигналов (${job.total} сайтов)`
      : isEmail
        ? `Поиск почт (${job.total} сайтов)`
        : `Обогащение сайтов (${job.total} строк)`;
    trace = await startTrace({
      name: traceName,
      input: { jobId, total: job.total, extraction_type: job.extraction_type },
      message: traceMessage,
      userId: job.user_id,
      jobId,
    });

    let processed = job.processed ?? 0;
    let success = job.success_count ?? 0;
    let errors = job.error_count ?? 0;

    if (job.status === 'completed') {
      const [pendingCount, processingCount, completedCount, failedCount, skippedCount] = await Promise.all([
        countQueue(jobId, 'pending'),
        countQueue(jobId, 'processing'),
        countQueue(jobId, 'completed'),
        countQueue(jobId, 'failed'),
        countQueue(jobId, 'skipped'),
      ]);
      if (pendingCount === 0 && processingCount === 0) return;
      processed = completedCount + failedCount + skippedCount;
      success = completedCount;
      errors = failedCount + skippedCount;
      await withSupabaseTimeout(
        supabaseAdmin
          .from('website_enrichment_jobs')
          .update({ status: 'running', completed_at: null })
          .eq('id', jobId),
        'Таймаут возобновления задачи',
      );
    }

    if (job.status === 'pending') {
      await withSupabaseTimeout(
        supabaseAdmin
          .from('website_enrichment_jobs')
          .update({ status: 'running', started_at: new Date().toISOString() })
          .eq('id', jobId),
        'Таймаут запуска задачи',
      );
    }
    let cancelled = false;

    // Reset stale processing items
    await withSupabaseTimeout(
      supabaseAdmin.rpc('reset_stale_website_enrichment_items', {
        p_job_id: jobId,
        p_minutes: STALE_PROCESSING_MINUTES,
      }),
      'Таймаут сброса зависших элементов очереди',
    ).catch(() => {});

    const inflight = new Map<string, Promise<FetchResult>>();
    let consecutiveDbErrors = 0;
    const MAX_CONSECUTIVE_DB_ERRORS = 20;

    // ─── Progress flush (debounced) ─────────────────────────────────
    //
    // До этого фикса: `processed` обновлялся в БД ОДИН раз — после полного
    // batch'а (60 items). При темпе ~30 items/мин batch занимает 2 минуты,
    // и первые 2 минуты после старта frontend читает processed=0. Юзер
    // видит «0% — Стоп», паникует, нажимает Стоп, перезапускает, опять
    // первые 2 минуты 0%, опять Стоп → итеративный фрустрационный цикл
    // (жалоба специалиста Ольги: 3 cancelled job'а подряд в БД).
    //
    // Watchdog в `enrich.ts` тоже завязан на `job.processed`: если оно
    // не изменилось за 10 мин — сбрасывает job в pending. Для batch'а
    // длиннее 10 мин (например при DOMAIN_CONCURRENCY=1 + много items
    // одного домена) watchdog убивал живые job'ы.
    //
    // Фикс: дебаунс-флэш processed каждые ~2.5 секунды. Это даёт юзеру
    // непрерывный прогресс с первых секунд + успокаивает watchdog.
    // БД нагружается умеренно: 1 UPDATE на job каждые 2.5s = 0.4 RPS
    // даже при 8 параллельных job'ах = 3.2 RPS, мизер для PostgREST.
    const PROGRESS_FLUSH_INTERVAL_MS = 2500;
    let lastProgressFlushAt = 0;
    let pendingFlushTimer: ReturnType<typeof setTimeout> | null = null;
    let flushInFlight = false;

    const doFlush = async () => {
      if (flushInFlight) return; // защита от наложений
      flushInFlight = true;
      lastProgressFlushAt = Date.now();
      try {
        // Multi-replica safety: when 2-3 workers co-attach to the same job
        // (see `claimEnrichJob` in worker/enrich.ts), each has its own local
        // `processed`/`success`/`errors` counters that count ONLY the items
        // it personally claimed. If each flushed those values, the last
        // writer would overwrite the others and progress would jitter
        // around a smaller-than-reality number.
        //
        // Instead, compute the globally correct totals from the queue
        // itself via a single COUNT-aggregate. Every replica then writes
        // the same numbers, so concurrent updates are idempotent.
        const [completedCount, failedCount, skippedCount] = await Promise.all([
          countQueue(jobId, 'completed'),
          countQueue(jobId, 'failed'),
          countQueue(jobId, 'skipped'),
        ]);
        const globalProcessed = completedCount + failedCount + skippedCount;
        const globalSuccess = completedCount;
        const globalErrors = failedCount + skippedCount;

        // Keep the per-replica locals in sync with the global view so any
        // logic that reads `processed`/`success`/`errors` later in this
        // function (final flush, completion detection) sees the real total
        // and doesn't double-count when multiple replicas finish.
        processed = globalProcessed;
        success = globalSuccess;
        errors = globalErrors;

        await withSupabaseTimeout(
          supabaseAdmin!
            .from('website_enrichment_jobs')
            .update({
              processed: globalProcessed,
              success_count: globalSuccess,
              error_count: globalErrors,
            })
            .eq('id', jobId),
          'Таймаут флэша прогресса',
        );
      } catch {
        // Игнорируем — следующий тик сделает свежий снимок.
      } finally {
        flushInFlight = false;
      }
    };

    const flushProgress = (force = false) => {
      const now = Date.now();
      const elapsed = now - lastProgressFlushAt;
      if (force || elapsed >= PROGRESS_FLUSH_INTERVAL_MS) {
        if (pendingFlushTimer) {
          clearTimeout(pendingFlushTimer);
          pendingFlushTimer = null;
        }
        void doFlush();
        return;
      }
      // Debounce: запланировать flush через (interval - elapsed) если ещё не запланировано.
      if (!pendingFlushTimer) {
        pendingFlushTimer = setTimeout(() => {
          pendingFlushTimer = null;
          void doFlush();
        }, PROGRESS_FLUSH_INTERVAL_MS - elapsed);
      }
    };

    // ─── Periodic apply to spreadsheet (email-only) ─────────────────────
    //
    // Жалоба Оли 26 мая: «прогресс 55%, в таблице 1 email». В БД на тот
    // момент 64 email уже completed, но frontend polling сбоил и не
    // подтягивал их в видимую таблицу.
    //
    // Раньше серверный apply вызывался ТОЛЬКО в финале job'а — то есть
    // safety-net'а во время работы не было. Плюс сам apply был broken для
    // юзеров с новой схемой state_compressed (читал колонку state которая
    // у них null).
    //
    // Фикс: периодически (раз в 60s) звать applyEnrichmentResults во время
    // работы — это вытащит свежие completed items в spreadsheet state.
    // applyEnrichmentResults внутри:
    //   - читает state_compressed (через shared loadCompressedState);
    //   - применяет результаты в копию state'а;
    //   - сохраняет с CAS (compare-and-swap по updated_at).
    // CAS защищает от race: если юзер параллельно правит ячейки и frontend
    // сейчас пишет state — наш save отбрасывается (no-op), на следующем
    // тике повторим. Никаких lost updates у юзера быть не может.
    //
    // Делаем только для email — у text/signals никто не жаловался,
    // а финальный apply для них тоже стал работать после фикса
    // state_compressed.
    const APPLY_INTERVAL_MS = 60_000;
    let lastApplyAt = 0;
    let pendingApplyTimer: ReturnType<typeof setTimeout> | null = null;
    let applyInFlight = false;
    const isEmailJob = job.extraction_type === 'email';
    const canApplyToSpreadsheet =
      isEmailJob &&
      !!job.spreadsheet_tab_id &&
      job.result_col_index != null;

    const doApply = async () => {
      if (applyInFlight) return;
      applyInFlight = true;
      lastApplyAt = Date.now();
      try {
        if (canApplyToSpreadsheet) {
          await applyEnrichmentResults(
            job.user_id,
            jobId,
            job.spreadsheet_tab_id!,
            job.result_col_index!,
            job.result_col_header ?? undefined,
          );
        }
      } catch {
        // apply не падает наружу — функция сама ловит ошибки и логирует
      } finally {
        applyInFlight = false;
      }
    };

    const maybeApplyToSpreadsheet = (force = false) => {
      if (!canApplyToSpreadsheet) return;
      const now = Date.now();
      const elapsed = now - lastApplyAt;
      if (force || elapsed >= APPLY_INTERVAL_MS) {
        if (pendingApplyTimer) {
          clearTimeout(pendingApplyTimer);
          pendingApplyTimer = null;
        }
        void doApply();
        return;
      }
      if (!pendingApplyTimer) {
        pendingApplyTimer = setTimeout(() => {
          pendingApplyTimer = null;
          void doApply();
        }, APPLY_INTERVAL_MS - elapsed);
      }
    };

    while (true) {
      if (consecutiveDbErrors >= MAX_CONSECUTIVE_DB_ERRORS) {
        throw new Error(`Supabase недоступен: ${consecutiveDbErrors} ошибок подряд, перезапускаем задачу`);
      }

      let jobStatus: { status: JobRow['status'] } | null = null;
      try {
        const result = await withSupabaseTimeout(
          supabaseAdmin
            .from('website_enrichment_jobs')
            .select('status')
            .eq('id', jobId)
            .single<{ status: JobRow['status'] }>(),
          'Таймаут проверки статуса задачи',
        );
        jobStatus = result.data;
        consecutiveDbErrors = 0;
      } catch {
        consecutiveDbErrors++;
        await sleep(2000 * Math.min(consecutiveDbErrors, 5));
        continue;
      }
      if (jobStatus?.status === 'cancelled') {
        cancelled = true;
        break;
      }

      let items: QueueItem[] | null = null;
      let error: unknown = null;
      try {
        const result = await withSupabaseTimeout(
          supabaseAdmin.rpc('claim_website_enrichment_items', {
            p_job_id: jobId,
            p_limit: WORKER_BATCH_SIZE,
          }),
          'Таймаут получения элементов очереди',
        );
        items = result.data as QueueItem[] | null;
        error = result.error;
        consecutiveDbErrors = 0;
      } catch (claimErr) {
        consecutiveDbErrors++;
        await logError('website.enrichment.worker.claim_timeout', claimErr, { jobId });
        await sleep(2000 * Math.min(consecutiveDbErrors, 5));
        continue;
      }

      if (error) {
        consecutiveDbErrors++;
        await logError('website.enrichment.worker.claim_failed', error, { jobId });
        await sleep(500);
        continue;
      }

      const batch = (items as QueueItem[]) ?? [];
      if (batch.length === 0) {
        const [pendingCount, processingCount] = await Promise.all([
          countQueue(jobId, 'pending'),
          countQueue(jobId, 'processing'),
        ]);
        if (pendingCount === 0 && processingCount === 0) break;

        if (processingCount > 0) {
          const oldestProcessing = await getOldestProcessingUpdatedAt(jobId);
          if (oldestProcessing && Date.now() - oldestProcessing.getTime() > staleProcessingMs) {
            await withSupabaseTimeout(
              supabaseAdmin.rpc('reset_stale_website_enrichment_items', {
                p_job_id: jobId,
                p_minutes: STALE_PROCESSING_MINUTES,
              }),
              'Таймаут сброса зависших элементов очереди (loop)',
            ).catch(() => {});
          }
        }

        await sleep(600);
        continue;
      }

      await mapWithConcurrency(
        batch,
        Math.max(1, Math.min(WORKER_CONCURRENCY, batch.length)),
        async (item) => {
          const domain = normalizeDomain(item.url_normalized || item.url_raw);
          const release = await acquireDomainSlot(domain);
          let finalized = false;
          try {
            if (MAX_ATTEMPTS > 0 && item.attempt_count > MAX_ATTEMPTS) {
              const marked = await updateQueueItem(
                item,
                { error: `Превышено число попыток (${MAX_ATTEMPTS})` },
                'failed',
              );
              if (marked) {
                errors += 1;
                finalized = true;
              }
              return;
            }
            const extractionType: ExtractionType = job.extraction_type ?? 'text';
            let result: FetchResult;
            if (extractionType === 'email') {
              result = await fetchEmailsWithCache(item, inflight);
            } else if (extractionType === 'signals') {
              result = await fetchSignalsForUrl(item, inflight, parseExtractors(job.extractors));
            } else {
              result = await fetchWithCache(item, inflight);
            }
            if (result.error && !result.text) {
              if (shouldRetryEnrichmentItem(result.error, item.attempt_count, MAX_ATTEMPTS)) {
                const requeued = await updateQueueItem(item, { error: result.error }, 'pending');
                if (!requeued) {
                  const markedFailed = await updateQueueItem(
                    item,
                    { error: result.error ?? 'Ошибка обогащения' },
                    'failed',
                  );
                  if (markedFailed) {
                    errors += 1;
                    finalized = true;
                  }
                }
              } else {
                const marked = await updateQueueItem(item, result, 'failed');
                if (marked) {
                  errors += 1;
                  finalized = true;
                }
              }
            } else {
              const markedCompleted = await updateQueueItem(item, { text: result.text ?? '' }, 'completed');
              if (markedCompleted) {
                success += 1;
                finalized = true;
              } else {
                const markedFailed = await updateQueueItem(
                  item,
                  { error: 'Ошибка записи результата обогащения' },
                  'failed',
                );
                if (markedFailed) {
                  errors += 1;
                  finalized = true;
                }
              }
            }
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Ошибка обогащения';
            const shouldRetry = shouldRetryEnrichmentItem(errorMessage, item.attempt_count, MAX_ATTEMPTS);
            const marked = await updateQueueItem(
              item,
              { error: errorMessage },
              shouldRetry ? 'pending' : 'failed',
            );
            if (marked) {
              if (!shouldRetry) {
                errors += 1;
                finalized = true;
              }
            } else {
              const markedFailed = await updateQueueItem(item, { error: errorMessage }, 'failed');
              if (markedFailed) {
                errors += 1;
                finalized = true;
              }
            }
            await logError('website.enrichment.worker.item_processing_failed', error, {
              jobId,
              itemId: item.id,
              rowIndex: item.row_index,
              url: item.url_raw,
            });
          } finally {
            if (finalized) {
              processed += 1;
              // Дёргаем debounced флэш — фактический UPDATE уйдёт не чаще
              // раза в 2.5s (или сразу если прошло >2.5s с предыдущего).
              flushProgress();
            }
            release();
          }
        },
      );

      // По окончании batch'а форсим финальный flush — гарантируем что
      // последний UPDATE с финальными значениями этого batch'а ушёл.
      flushProgress(true);
      // Дебаунс-apply spreadsheet (no-op если не email или нет tab_id;
      // CAS внутри защитит от race с frontend save'ом).
      maybeApplyToSpreadsheet();
    }

    // Выходим из batch loop → чистим pending flush + apply таймеры и форсим
    // последний апдейт. Без cleanup setTimeout мог бы «выстрелить» после того
    // как Node уже думает что работа закончена.
    if (pendingFlushTimer) {
      clearTimeout(pendingFlushTimer);
      pendingFlushTimer = null;
    }
    if (pendingApplyTimer) {
      clearTimeout(pendingApplyTimer);
      pendingApplyTimer = null;
    }
    // Финальный force-flush ниже идёт через тот же UPDATE что и завершение
    // (строка `.update({ status, processed: processedTotal, ... })`), так что
    // дополнительный flushProgress(true) здесь не нужен — он бы делал лишний
    // UPDATE дублирующий финальный.

    if (cancelled) {
      const now = new Date().toISOString();
      await withSupabaseTimeout(
        supabaseAdmin
          .from('website_enrichment_queue')
          .update({
            status: 'failed',
            last_error: 'Операция отменена пользователем',
            updated_at: now,
            completed_at: now,
          })
          .eq('job_id', jobId)
          .in('status', ['pending', 'processing']),
        'Таймаут отмены элементов очереди',
      ).catch(() => {});
    }

    const [completedCount, failedCount, skippedCount] = await Promise.all([
      countQueue(jobId, 'completed'),
      countQueue(jobId, 'failed'),
      countQueue(jobId, 'skipped'),
    ]);
    const processedTotal = completedCount + failedCount + skippedCount;
    const finalSuccess = completedCount;
    const finalErrors = failedCount + skippedCount;

    const finalStatus: JobRow['status'] = cancelled ? 'cancelled' : 'completed';
    await withSupabaseTimeout(
      supabaseAdmin
        .from('website_enrichment_jobs')
        .update({
          status: finalStatus,
          processed: processedTotal,
          success_count: finalSuccess,
          error_count: finalErrors,
          completed_at: new Date().toISOString(),
        })
        .eq('id', jobId),
      'Таймаут финализации задачи',
    );

    await logInfo('website.enrichment.worker.completed', 'Website enrichment job completed', {
      jobId,
      processed: processedTotal,
      success: finalSuccess,
      errors: finalErrors,
    });

    if (
      finalStatus === 'completed' &&
      job.spreadsheet_tab_id &&
      job.result_col_index != null
    ) {
      if (job.extraction_type === 'signals' && job.result_col_index_2 != null) {
        await applySignalJobResults(
          job.user_id,
          jobId,
          job.spreadsheet_tab_id,
          {
            stackColIndex: job.result_col_index,
            profileColIndex: job.result_col_index_2,
            stackHeader: job.result_col_header ?? 'Стек',
            profileHeader: job.result_col_header_2 ?? 'Профиль',
            applyOnlyEmpty: true,
            extraCols: parseExtraCols(job.extra_cols),
          },
        );
      } else {
        await applyEnrichmentResults(
          job.user_id,
          jobId,
          job.spreadsheet_tab_id,
          job.result_col_index,
          job.result_col_header ?? undefined,
        );
      }
    }

    await trace?.end({ processed: processedTotal, success: finalSuccess, errors: finalErrors, status: finalStatus });
  } catch (err) {
    await logError('website.enrichment.worker.failed', err, { jobId });
    await trace?.fail(err);
    if (supabaseAdmin) {
      await withSupabaseTimeout(
        supabaseAdmin
          .from('website_enrichment_jobs')
          .update({
            status: 'failed',
            completed_at: new Date().toISOString(),
            error_message: err instanceof Error ? err.message : 'Worker error',
          })
          .eq('id', jobId),
        'Таймаут записи ошибки задачи',
      ).catch(() => {});
    }
  }
}

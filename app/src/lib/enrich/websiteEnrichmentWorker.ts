import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logError, logInfo } from '@/lib/loggerServer';
import { fetchAndExtract, normalizeUrl } from '@/lib/enrich/websiteParser';
import { scrapeEmails } from '@/lib/enrich/emailScraper';
import { runWithTimeout } from '@/lib/enrich/timeoutUtils';
import { shouldRetryEnrichmentItem, shouldUseCachedError } from '@/lib/enrich/errorPolicy';

type QueueItem = {
  id: string;
  job_id: string;
  row_index: number;
  url_raw: string;
  url_normalized: string;
  attempt_count: number;
};

type ExtractionType = 'text' | 'email';

type JobRow = {
  id: string;
  user_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  extraction_type: ExtractionType;
  total: number;
  processed: number;
  success_count: number;
  error_count: number;
};

type FetchResult = { text?: string; error?: string };

const WORKER_CONCURRENCY = Number(process.env.WEBSITE_ENRICHMENT_CONCURRENCY ?? '10');
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

const cacheSuccessTtlMs = CACHE_SUCCESS_DAYS * 24 * 60 * 60 * 1000;
const cacheErrorTtlMs = CACHE_ERROR_HOURS * 60 * 60 * 1000;
const staleProcessingMs = STALE_PROCESSING_MINUTES * 60 * 1000;

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

async function setCache(urlNormalized: string, payload: { text?: string; error?: string; sourceUrl?: string }) {
  if (!supabaseAdmin) return;
  const now = new Date();
  const expiresAt =
    payload.text && payload.text.length > 0
      ? new Date(now.getTime() + cacheSuccessTtlMs)
      : new Date(now.getTime() + cacheErrorTtlMs);

  try {
    await withSupabaseTimeout(
      supabaseAdmin
        .from('website_enrichment_cache')
        .upsert(
          {
            url_normalized: urlNormalized,
            text: payload.text ?? null,
            last_error: payload.error ?? null,
            fetched_at: now.toISOString(),
            expires_at: expiresAt.toISOString(),
            source_url: payload.sourceUrl ?? null,
          },
          { onConflict: 'url_normalized' },
        ),
      'Таймаут записи кэша сайта',
    );
  } catch {
    // Cache write should not break item processing.
  }
}

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
  } catch {
    // Cache write should not break item processing.
  }
}

async function fetchEmailsWithCache(
  item: QueueItem,
  inflight: Map<string, Promise<FetchResult>>,
): Promise<FetchResult> {
  const key = `email:${item.url_normalized}`;
  if (inflight.has(key)) return inflight.get(key)!;

  const promise = (async () => {
    if (item.url_normalized) {
      const cached = await getEmailCache(item.url_normalized);
      if (cached && cached.expires_at && new Date(cached.expires_at).getTime() > Date.now()) {
        if (cached.last_error && !cached.emails && shouldUseCachedError(cached.last_error)) {
          return { error: cached.last_error };
        }
        return { text: cached.emails ?? '' };
      }
    }

    try {
      const abortController = new AbortController();
      const result = await runWithTimeout(
        scrapeEmails(item.url_raw, {
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
      if (item.url_normalized) {
        await setEmailCache(item.url_normalized, {
          emails: emailsText,
          sourceUrl: item.url_raw,
          pagesScanned: result.pagesScanned,
        });
      }
      return { text: emailsText };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Ошибка извлечения email';
      if (item.url_normalized && shouldUseCachedError(message)) {
        await setEmailCache(item.url_normalized, { error: message, sourceUrl: item.url_raw });
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

async function updateQueueItem(
  item: QueueItem,
  result: FetchResult,
  status: 'pending' | 'completed' | 'failed' | 'skipped',
): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const now = new Date().toISOString();
  try {
    const { error } = await withSupabaseTimeout(
      supabaseAdmin
        .from('website_enrichment_queue')
        .update({
          status,
          result_text: status === 'completed' ? result.text ?? null : null,
          last_error: status === 'completed' ? null : result.error ?? null,
          updated_at: now,
          completed_at: status === 'pending' ? null : now,
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

  try {
    const { data: job, error: jobError } = await supabaseAdmin
      .from('website_enrichment_jobs')
      .select('id, user_id, status, extraction_type, total, processed, success_count, error_count')
      .eq('id', jobId)
      .single<JobRow>();

    if (jobError || !job) {
      await logError('website.enrichment.worker.job_not_found', jobError ?? new Error('Job not found'), { jobId });
      return;
    }

    if (['failed', 'cancelled'].includes(job.status)) return;

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
      await supabaseAdmin
        .from('website_enrichment_jobs')
        .update({ status: 'running', completed_at: null })
        .eq('id', jobId);
    }

    if (job.status === 'pending') {
      await supabaseAdmin
        .from('website_enrichment_jobs')
        .update({ status: 'running', started_at: new Date().toISOString() })
        .eq('id', jobId);
    }
    let cancelled = false;

    // Reset stale processing items
    await supabaseAdmin.rpc('reset_stale_website_enrichment_items', {
      p_job_id: jobId,
      p_minutes: STALE_PROCESSING_MINUTES,
    });

    const inflight = new Map<string, Promise<FetchResult>>();
    while (true) {
      const { data: jobStatus } = await supabaseAdmin
        .from('website_enrichment_jobs')
        .select('status')
        .eq('id', jobId)
        .single<{ status: JobRow['status'] }>();
      if (jobStatus?.status === 'cancelled') {
        cancelled = true;
        break;
      }

      const { data: items, error } = await supabaseAdmin.rpc('claim_website_enrichment_items', {
        p_job_id: jobId,
        p_limit: WORKER_BATCH_SIZE,
      });

      if (error) {
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
            await supabaseAdmin.rpc('reset_stale_website_enrichment_items', {
              p_job_id: jobId,
              p_minutes: STALE_PROCESSING_MINUTES,
            });
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
            const result = extractionType === 'email'
              ? await fetchEmailsWithCache(item, inflight)
              : await fetchWithCache(item, inflight);
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
            if (finalized) processed += 1;
            release();
          }
        },
      );

      await supabaseAdmin
        .from('website_enrichment_jobs')
        .update({
          processed,
          success_count: success,
          error_count: errors,
        })
        .eq('id', jobId);
    }

    if (cancelled) {
      const now = new Date().toISOString();
      await supabaseAdmin
        .from('website_enrichment_queue')
        .update({
          status: 'failed',
          last_error: 'Операция отменена пользователем',
          updated_at: now,
          completed_at: now,
        })
        .eq('job_id', jobId)
        .in('status', ['pending', 'processing']);
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
    await supabaseAdmin
      .from('website_enrichment_jobs')
      .update({
        status: finalStatus,
        processed: processedTotal,
        success_count: finalSuccess,
        error_count: finalErrors,
        completed_at: new Date().toISOString(),
      })
      .eq('id', jobId);

    await logInfo('website.enrichment.worker.completed', 'Website enrichment job completed', {
      jobId,
      processed: processedTotal,
      success: finalSuccess,
      errors: finalErrors,
    });
  } catch (err) {
    await logError('website.enrichment.worker.failed', err, { jobId });
    if (supabaseAdmin) {
      await supabaseAdmin
        .from('website_enrichment_jobs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: err instanceof Error ? err.message : 'Worker error',
        })
        .eq('id', jobId);
    }
  }
}

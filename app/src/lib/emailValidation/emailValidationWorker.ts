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
const MAX_ATTEMPTS = Number(process.env.EMAIL_VALIDATION_MAX_ATTEMPTS ?? '3');
const STALE_PROCESSING_MINUTES = Number(process.env.EMAIL_VALIDATION_STALE_MINUTES ?? '5');
const DOMAIN_CONCURRENCY = Number(process.env.EMAIL_VALIDATION_DOMAIN_CONCURRENCY ?? '3');
const DOMAIN_CACHE_TTL_MS = Number(process.env.EMAIL_VALIDATION_DOMAIN_CACHE_TTL_MS ?? String(24 * 60 * 60 * 1000));
const JOB_PROGRESS_FLUSH_INTERVAL = Number(process.env.EMAIL_VALIDATION_PROGRESS_FLUSH_MS ?? '2000');
const SUPABASE_QUERY_TIMEOUT_MS = 30_000;
const GREYLIST_DELAY_MS = Number(process.env.EMAIL_VALIDATION_GREYLIST_DELAY_MS ?? String(5 * 60 * 1000));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function cleanupQueue(jobId: string): Promise<void> {
  const db = supabaseAdmin;
  if (!db) return;
  workerLog('info', `Cleaning up queue for job ${jobId}...`);
  let totalDeleted = 0;
  while (true) {
    const { data, error } = await db
      .from('email_validation_queue')
      .delete()
      .eq('job_id', jobId)
      .limit(CLEANUP_BATCH_SIZE)
      .select('id');
    if (error) {
      workerLog('warn', `Cleanup error for job ${jobId}`, error);
      break;
    }
    const deleted = data?.length ?? 0;
    totalDeleted += deleted;
    if (deleted < CLEANUP_BATCH_SIZE) break;
  }
  workerLog('info', `Cleaned up ${totalDeleted} queue items for job ${jobId}`);
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

async function loadDomainCache(jobId: string): Promise<Map<string, DomainInfo>> {
  const cache = new Map<string, DomainInfo>();
  if (!supabaseAdmin) return cache;

  try {
    const { data } = await supabaseAdmin
      .from('email_validation_domain_cache')
      .select('domain, mx_hosts, mx_found, is_catch_all, is_disposable, checked_at, expires_at')
      .gt('expires_at', new Date().toISOString())
      .limit(10000);

    if (data) {
      for (const row of data) {
        cache.set(row.domain, {
          domain: row.domain,
          mxHosts: row.mx_hosts ?? [],
          mxFound: row.mx_found ?? false,
          isCatchAll: row.is_catch_all,
          isDisposable: row.is_disposable ?? false,
          checkedAt: new Date(row.checked_at),
        });
      }
    }
  } catch (err) {
    await logError('email.validation.worker.domain_cache_load_failed', err, { jobId });
  }

  return cache;
}

async function saveDomainCache(domainCache: Map<string, DomainInfo>): Promise<void> {
  if (!supabaseAdmin || domainCache.size === 0) return;

  const rows = Array.from(domainCache.values()).map((d) => ({
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
    } catch {
      // Non-critical
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

function isGreylistError(error: string | undefined): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return lower.includes('greylist') || lower.includes('временн') || lower.includes('450') || lower.includes('451');
}

function shouldRetry(error: string | undefined, attempts: number): boolean {
  if (attempts >= MAX_ATTEMPTS) return false;
  if (!error) return false;
  const retryable = [
    'greylist', 'timeout', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED',
    'EHOSTUNREACH', 'ENETUNREACH', 'временн', '450', '451',
    'dns lookup failed', // transient MX-undetermined (not greylist) → re-queue
    'prox', 'fetch failed', 'aborted', // proxy down/restarting → re-queue, not terminal
  ];
  const lower = error.toLowerCase();
  return retryable.some((k) => lower.includes(k.toLowerCase()));
}

// ─── Main worker function ───────────────────────────────────────────────────

export async function runEmailValidationJob(jobId: string) {
  if (!supabaseAdmin) {
    await logError('email.validation.worker.no_admin', new Error('supabaseAdmin is not configured'));
    return;
  }

  const db = supabaseAdmin;
  let trace: Span | null = null;

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
      await db
        .from('email_validation_jobs')
        .update({ status: 'running', completed_at: null })
        .eq('id', jobId);
    }

    if (job.status === 'pending') {
      await db
        .from('email_validation_jobs')
        .update({ status: 'running', started_at: new Date().toISOString() })
        .eq('id', jobId);
    }

    let cancelled = false;

    // Reset stale processing items
    await db.rpc('reset_stale_email_validation_items', {
      p_job_id: jobId,
      p_minutes: STALE_PROCESSING_MINUTES,
    });

    // Load domain cache
    const domainCache = await loadDomainCache(jobId);
    let lastProgressFlush = Date.now();

    // Periodic progress flush to avoid hammering DB
    const flushProgress = async () => {
      const now = Date.now();
      if (now - lastProgressFlush < JOB_PROGRESS_FLUSH_INTERVAL) return;
      lastProgressFlush = now;
      await db
        .from('email_validation_jobs')
        .update({ processed, success_count: success, error_count: errors })
        .eq('id', jobId);
    };

    // ── Main processing loop ────────────────────────────────────────────
    while (true) {
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

        // Reset stale items if they exist
        if (processingCount > 0) {
          await db.rpc('reset_stale_email_validation_items', {
            p_job_id: jobId,
            p_minutes: STALE_PROCESSING_MINUTES,
          });
        }

        await sleep(600);
        continue;
      }

      // Process batch with concurrency
      await mapWithConcurrency(
        batch,
        Math.max(1, Math.min(WORKER_CONCURRENCY, batch.length)),
        async (item) => {
          const domain = item.email_normalized.split('@')[1] ?? '';
          const release = await acquireDomainSlot(domain);

          try {
            if (item.attempt_count > MAX_ATTEMPTS) {
              await updateQueueItemResult(item, null, 'failed', `Превышено число попыток (${MAX_ATTEMPTS})`);
              errors += 1;
              processed += 1;
              return;
            }

            const result = await validateEmail(item.email_normalized, domainCache);

            if (result.error && result.result === 'unknown' && shouldRetry(result.error, item.attempt_count)) {
              const greylist = isGreylistError(result.error);
              if (greylist) {
                workerLog('info', `Greylisting detected for ${item.email_normalized}, retry in ${GREYLIST_DELAY_MS / 1000}s`);
              }
              await requeueItem(item, greylist);
              return;
            }

            await updateQueueItemResult(item, result, 'completed', null);
            if (result.quality === 'bad') {
              errors += 1;
            } else {
              success += 1;
            }
            processed += 1;
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Ошибка валидации';
            if (shouldRetry(msg, item.attempt_count)) {
              await requeueItem(item, isGreylistError(msg));
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
      workerLog('info', `Job ${jobId}: processed=${processed}/${job.total} (batch=${batch.length}, success=${success}, errors=${errors})`);
    }

    // ── Finalization ──────────────────────────────────────────────────────

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
    await db
      .from('email_validation_jobs')
      .update({
        status: finalStatus,
        processed: completedCount + failedCount,
        success_count: completedCount,
        error_count: failedCount,
        completed_at: new Date().toISOString(),
      })
      .eq('id', jobId);

    // Persist domain cache for future jobs
    await saveDomainCache(domainCache);

    workerLog('info', `Job ${jobId} FINISHED: status=${finalStatus}, completed=${completedCount}, failed=${failedCount}`);
    await logInfo('email.validation.worker.completed', 'Email validation job completed', {
      jobId, processed: completedCount + failedCount, success: completedCount, errors: failedCount,
    });
    await trace?.end({ processed: completedCount + failedCount, success: completedCount, errors: failedCount, status: finalStatus });

    await cleanupQueue(jobId);

  } catch (err) {
    workerLog('error', `Job ${jobId} CRASHED`, err);
    await logError('email.validation.worker.failed', err, { jobId });
    await trace?.fail(err);
    await db
      .from('email_validation_jobs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_message: err instanceof Error ? err.message : 'Worker error',
      })
      .eq('id', jobId);
    await cleanupQueue(jobId);
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

async function requeueItem(item: QueueItem, greylist = false): Promise<void> {
  if (!supabaseAdmin) return;
  try {
    const now = new Date().toISOString();
    const update: Record<string, unknown> = { status: 'pending', updated_at: now };
    if (greylist) {
      update.retry_after = new Date(Date.now() + GREYLIST_DELAY_MS).toISOString();
    }
    await supabaseAdmin
      .from('email_validation_queue')
      .update(update)
      .eq('id', item.id);
  } catch {
    // Non-critical
  }
}

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logError, logInfo } from '@/lib/loggerServer';
import { scoreBriefCompanies, type BriefScoringResult } from '@/lib/briefScoring/scoring';
import { applyBriefScoringResults } from '@/lib/spreadsheet/applyJobResults';
import { startTrace } from '@/lib/tracer';
import type { Span } from '@/lib/tracer';

type QueueItem = {
  id: string;
  job_id: string;
  row_index: number;
  company_data: Record<string, unknown> | null;
  attempt_count: number;
};

type JobRow = {
  id: string;
  user_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  brief_text: string;
  total: number;
  processed: number;
  success_count: number;
  error_count: number;
  spreadsheet_tab_id: string | null;
  score_col_index: number | null;
  reason_col_index: number | null;
};

type QueueStatus = 'pending' | 'processing' | 'completed' | 'failed';

const WORKER_BATCH_SIZE = Number(process.env.BRIEF_SCORING_WORKER_BATCH_SIZE ?? '40');
const MODEL_BATCH_SIZE = Number(process.env.BRIEF_SCORING_MODEL_BATCH_SIZE ?? '10');
const MAX_ATTEMPTS = Number(process.env.BRIEF_SCORING_MAX_ATTEMPTS ?? '3');
const STALE_PROCESSING_MINUTES = Number(process.env.BRIEF_SCORING_STALE_MINUTES ?? '5');
const OPENROUTER_BRIEF_API_KEY = process.env.OPENROUTER_BRIEF_API_KEY ?? '';
const SUPABASE_QUERY_TIMEOUT_MS = Number(process.env.BRIEF_SCORING_DB_TIMEOUT_MS ?? '30000');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function withSupabaseTimeout<T>(operation: PromiseLike<T>, timeoutMessage: string): Promise<T> {
  return Promise.race([
    Promise.resolve(operation),
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(timeoutMessage)), SUPABASE_QUERY_TIMEOUT_MS)),
  ]);
}

function shouldRetryBriefScoringError(errorMessage: string, attemptCount: number): boolean {
  if (attemptCount >= MAX_ATTEMPTS) return false;
  const lower = errorMessage.toLowerCase();
  const retryable = [
    '502',
    '503',
    '504',
    'timeout',
    'network',
    'ошибка сети',
  ];
  return retryable.some((token) => lower.includes(token));
}

function toCompanyData(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>((acc, [key, raw]) => {
    const normalized = String(raw ?? '').trim();
    if (normalized.length > 0) acc[key] = normalized;
    return acc;
  }, {});
}

async function countQueue(jobId: string, status: QueueStatus): Promise<number> {
  if (!supabaseAdmin) return 0;
  try {
    const { count, error } = await withSupabaseTimeout(
      supabaseAdmin
        .from('brief_scoring_queue')
        .select('id', { count: 'exact', head: true })
        .eq('job_id', jobId)
        .eq('status', status),
      'Таймаут countQueue (brief_scoring_queue)',
    );
    if (error) return 0;
    return count ?? 0;
  } catch {
    return 0;
  }
}

async function updateQueueCompleted(item: QueueItem, score: BriefScoringResult): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const now = new Date().toISOString();
  try {
    const { error } = await withSupabaseTimeout(
      supabaseAdmin
        .from('brief_scoring_queue')
        .update({
          status: 'completed',
          score: score.score,
          reason: score.reason,
          last_error: null,
          updated_at: now,
          completed_at: now,
        })
        .eq('id', item.id),
      `Таймаут updateQueueCompleted (${item.id})`,
    );
    return !error;
  } catch {
    return false;
  }
}

async function updateQueueFailed(item: QueueItem, errorMessage: string): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const now = new Date().toISOString();
  try {
    const { error } = await withSupabaseTimeout(
      supabaseAdmin
        .from('brief_scoring_queue')
        .update({
          status: 'failed',
          score: null,
          reason: null,
          last_error: errorMessage,
          updated_at: now,
          completed_at: now,
        })
        .eq('id', item.id),
      `Таймаут updateQueueFailed (${item.id})`,
    );
    return !error;
  } catch {
    return false;
  }
}

async function requeueItem(item: QueueItem, errorMessage: string): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const now = new Date().toISOString();
  try {
    const { error } = await withSupabaseTimeout(
      supabaseAdmin
        .from('brief_scoring_queue')
        .update({
          status: 'pending',
          score: null,
          reason: null,
          last_error: errorMessage,
          updated_at: now,
          started_at: null,
          completed_at: null,
        })
        .eq('id', item.id),
      `Таймаут requeueItem (${item.id})`,
    );
    return !error;
  } catch {
    return false;
  }
}

export async function runBriefScoringJob(jobId: string) {
  if (!supabaseAdmin) {
    await logError('brief.scoring.worker.no_admin', new Error('supabaseAdmin is not configured'), { jobId });
    return;
  }

  let trace: Span | null = null;

  if (!OPENROUTER_BRIEF_API_KEY) {
    await logError(
      'brief.scoring.worker.missing_api_key',
      new Error('OPENROUTER_BRIEF_API_KEY not configured'),
      { jobId },
    );
    await supabaseAdmin
      .from('brief_scoring_jobs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_message: 'OPENROUTER_BRIEF_API_KEY not configured',
      })
      .eq('id', jobId);
    return;
  }

  try {
    const { data: job, error: jobError } = await supabaseAdmin
      .from('brief_scoring_jobs')
      .select('id, user_id, status, brief_text, total, processed, success_count, error_count, spreadsheet_tab_id, score_col_index, reason_col_index')
      .eq('id', jobId)
      .single<JobRow>();

    if (jobError || !job) {
      await logError('brief.scoring.worker.job_not_found', jobError ?? new Error('Job not found'), { jobId });
      return;
    }

    if (['failed', 'cancelled'].includes(job.status)) return;

    trace = await startTrace({
      name: 'database.brief_scoring',
      input: { jobId, total: job.total },
      message: `Скоринг по брифу (${job.total} компаний)`,
      userId: job.user_id,
      jobId,
    });

    let processed = job.processed ?? 0;
    let success = job.success_count ?? 0;
    let errors = job.error_count ?? 0;

    if (job.status === 'pending') {
      await supabaseAdmin
        .from('brief_scoring_jobs')
        .update({ status: 'running', started_at: new Date().toISOString() })
        .eq('id', jobId);
    }

    let cancelled = false;

    await supabaseAdmin.rpc('reset_stale_brief_scoring_items', {
      p_job_id: jobId,
      p_minutes: STALE_PROCESSING_MINUTES,
    });

    while (true) {
      const { data: jobStatus } = await supabaseAdmin
        .from('brief_scoring_jobs')
        .select('status')
        .eq('id', jobId)
        .single<{ status: JobRow['status'] }>();
      if (jobStatus?.status === 'cancelled') {
        cancelled = true;
        break;
      }

      const { data: claimedItems, error: claimError } = await supabaseAdmin.rpc('claim_brief_scoring_items', {
        p_job_id: jobId,
        p_limit: WORKER_BATCH_SIZE,
      });

      if (claimError) {
        await logError('brief.scoring.worker.claim_failed', claimError, { jobId });
        await sleep(500);
        continue;
      }

      const batch = (claimedItems as QueueItem[] | null) ?? [];
      if (batch.length === 0) {
        const [pendingCount, processingCount] = await Promise.all([
          countQueue(jobId, 'pending'),
          countQueue(jobId, 'processing'),
        ]);
        if (pendingCount === 0 && processingCount === 0) break;

        if (processingCount > 0) {
          await supabaseAdmin.rpc('reset_stale_brief_scoring_items', {
            p_job_id: jobId,
            p_minutes: STALE_PROCESSING_MINUTES,
          });
        }

        await sleep(600);
        continue;
      }

      for (let i = 0; i < batch.length; i += MODEL_BATCH_SIZE) {
        const chunk = batch.slice(i, i + MODEL_BATCH_SIZE);

        const overAttemptItems = chunk.filter((item) => MAX_ATTEMPTS > 0 && item.attempt_count > MAX_ATTEMPTS);
        for (const item of overAttemptItems) {
          const marked = await updateQueueFailed(item, `Превышено число попыток (${MAX_ATTEMPTS})`);
          if (marked) {
            errors += 1;
            processed += 1;
          }
        }

        const activeItems = chunk.filter((item) => !overAttemptItems.some((it) => it.id === item.id));
        if (activeItems.length === 0) continue;

        try {
          const scores = await scoreBriefCompanies({
            apiKey: OPENROUTER_BRIEF_API_KEY,
            briefText: job.brief_text,
            companies: activeItems.map((item) => ({
              idx: item.row_index,
              data: toCompanyData(item.company_data),
            })),
          });

          const scoresByRow = new Map<number, BriefScoringResult>();
          for (const score of scores) scoresByRow.set(score.idx, score);

          for (const item of activeItems) {
            const score = scoresByRow.get(item.row_index);
            if (!score) {
              const failed = await updateQueueFailed(item, 'Нет оценки от AI');
              if (failed) {
                errors += 1;
                processed += 1;
              }
              continue;
            }

            const completed = await updateQueueCompleted(item, score);
            if (completed) {
              success += 1;
              processed += 1;
            } else {
              const failed = await updateQueueFailed(item, 'Ошибка записи результата');
              if (failed) {
                errors += 1;
                processed += 1;
              }
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Ошибка оценки ЦА';

          for (const item of activeItems) {
            const retry = shouldRetryBriefScoringError(message, item.attempt_count);
            if (retry) {
              await requeueItem(item, message);
              continue;
            }
            const failed = await updateQueueFailed(item, message);
            if (failed) {
              errors += 1;
              processed += 1;
            }
          }

          await logError('brief.scoring.worker.batch_failed', err, {
            jobId,
            batchSize: activeItems.length,
          });
        }
      }

      await supabaseAdmin
        .from('brief_scoring_jobs')
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
        .from('brief_scoring_queue')
        .update({
          status: 'failed',
          score: null,
          reason: null,
          last_error: 'Операция отменена пользователем',
          updated_at: now,
          completed_at: now,
        })
        .eq('job_id', jobId)
        .in('status', ['pending', 'processing']);
    }

    const [completedCount, failedCount] = await Promise.all([
      countQueue(jobId, 'completed'),
      countQueue(jobId, 'failed'),
    ]);

    const processedTotal = completedCount + failedCount;
    const finalStatus: JobRow['status'] = cancelled ? 'cancelled' : 'completed';

    await supabaseAdmin
      .from('brief_scoring_jobs')
      .update({
        status: finalStatus,
        processed: processedTotal,
        success_count: completedCount,
        error_count: failedCount,
        completed_at: new Date().toISOString(),
      })
      .eq('id', jobId);

    await logInfo('brief.scoring.worker.completed', 'Brief scoring job completed', {
      jobId,
      status: finalStatus,
      processed: processedTotal,
      success: completedCount,
      errors: failedCount,
    });

    if (
      finalStatus === 'completed' &&
      job.spreadsheet_tab_id &&
      job.score_col_index != null &&
      job.reason_col_index != null
    ) {
      await applyBriefScoringResults(
        job.user_id,
        jobId,
        job.spreadsheet_tab_id,
        job.score_col_index,
        job.reason_col_index,
      );
    }

    await trace?.end({ processed: processedTotal, success: completedCount, errors: failedCount, status: finalStatus });
  } catch (err) {
    await logError('brief.scoring.worker.failed', err, { jobId });
    await trace?.fail(err);
    if (supabaseAdmin) {
      await supabaseAdmin
        .from('brief_scoring_jobs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: err instanceof Error ? err.message : 'Worker error',
        })
        .eq('id', jobId);
    }
  }
}


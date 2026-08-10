import type { SupabaseClient } from '@supabase/supabase-js';
import { isTransientError, withRetry } from '@/lib/supabaseRetry';

export type WebsiteEnrichmentDb = Pick<SupabaseClient, 'from'>;

export type WebsiteEnrichmentJobPayload = {
  user_id: string;
  extraction_type: 'text' | 'email' | 'signals';
  total: number;
  processed: number;
  success_count: number;
  error_count: number;
  created_at: string;
  [key: string]: unknown;
};

export type WebsiteEnrichmentQueuePayload = {
  user_id: string;
  row_index: number;
  url_raw: string;
  url_normalized: string;
  status: 'pending' | 'failed';
  [key: string]: unknown;
};

const QUEUE_BATCH_SIZE = 500;
const PUBLISH_RETRY_OPTIONS = {
  retries: 2,
  baseDelayMs: 250,
  maxDelayMs: 1_000,
} as const;

function retryTransientDbOperation<T>(operation: () => Promise<T>): Promise<T> {
  return withRetry(operation, PUBLISH_RETRY_OPTIONS);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error || 'Unknown website enrichment queue error');
}

async function markPreparingJobFailed(
  db: WebsiteEnrichmentDb,
  jobId: string,
  message: string,
): Promise<void> {
  await retryTransientDbOperation(async () => {
    const { error } = await db
      .from('website_enrichment_jobs')
      .update({
        status: 'failed',
        error_message: message,
        completed_at: new Date().toISOString(),
      })
      .eq('id', jobId)
      .eq('status', 'preparing');
    if (error) throw error;
  });
}

async function refreshPreparingJobHeartbeat(
  db: WebsiteEnrichmentDb,
  jobId: string,
): Promise<void> {
  const { data } = await retryTransientDbOperation(async () => {
    const result = await db
      .from('website_enrichment_jobs')
      .update({ preparing_heartbeat_at: new Date().toISOString() })
      .eq('id', jobId)
      .eq('status', 'preparing')
      .select('id')
      .maybeSingle<{ id: string }>();
    if (result.error) throw result.error;
    return result;
  });
  if (!data) throw new Error('Website enrichment job is no longer preparing');
}

export async function publishWebsiteEnrichmentJob(
  db: WebsiteEnrichmentDb,
  jobPayload: WebsiteEnrichmentJobPayload,
  queuePayloads: WebsiteEnrichmentQueuePayload[],
): Promise<string> {
  if (queuePayloads.length !== jobPayload.total) {
    throw new Error(
      `Website enrichment queue payload mismatch: ${queuePayloads.length}/${jobPayload.total}`,
    );
  }

  const { data: job, error: jobError } = await db
    .from('website_enrichment_jobs')
    .insert({
      ...jobPayload,
      status: 'preparing',
      preparing_heartbeat_at: new Date().toISOString(),
    })
    .select('id')
    .single<{ id: string }>();

  if (jobError || !job) {
    throw new Error(jobError?.message ?? 'Failed to create website enrichment job');
  }

  try {
    const rows = queuePayloads.map((item) => ({ ...item, job_id: job.id }));
    for (let index = 0; index < rows.length; index += QUEUE_BATCH_SIZE) {
      if (index > 0) await refreshPreparingJobHeartbeat(db, job.id);
      const batch = rows.slice(index, index + QUEUE_BATCH_SIZE);
      await retryTransientDbOperation(async () => {
        const { error } = await db
          .from('website_enrichment_queue')
          .upsert(batch, {
            onConflict: 'job_id,row_index',
            ignoreDuplicates: true,
          });
        if (error) throw error;
      });
    }

    const { count } = await retryTransientDbOperation(async () => {
      const result = await db
        .from('website_enrichment_queue')
        .select('id', { count: 'exact', head: true })
        .eq('job_id', job.id);
      if (result.error) throw result.error;
      return result;
    });
    if (count !== jobPayload.total) {
      throw new Error(`Website enrichment queue incomplete: ${count ?? 0}/${jobPayload.total}`);
    }
    await refreshPreparingJobHeartbeat(db, job.id);

    await retryTransientDbOperation(async () => {
      const { data: published, error: publishError } = await db
        .from('website_enrichment_jobs')
        .update({ status: 'pending' })
        .eq('id', job.id)
        .eq('status', 'preparing')
        .select('id')
        .maybeSingle<{ id: string }>();
      if (publishError) throw publishError;
      if (published) return;

      const { data: current, error: currentError } = await db
        .from('website_enrichment_jobs')
        .select('status')
        .eq('id', job.id)
        .maybeSingle<{ status: string }>();
      if (currentError) throw currentError;
      if (current && ['pending', 'running', 'completed'].includes(current.status)) return;

      throw new Error('Website enrichment job is no longer preparing');
    });

    return job.id;
  } catch (error) {
    const message = errorMessage(error);
    if (isTransientError(error)) {
      throw new Error(message);
    }
    try {
      await markPreparingJobFailed(db, job.id, message);
    } catch (markError) {
      throw new Error(
        `${message}; failed to mark staged website enrichment job failed: ${errorMessage(markError)}`,
      );
    }
    throw new Error(message);
  }
}

export async function recoverStalePreparingWebsiteEnrichmentJobs(
  db: WebsiteEnrichmentDb,
  olderThanIso: string,
): Promise<{ published: number; failed: number }> {
  type PreparingJobRow = {
    id: string;
    total: number;
    created_at: string;
    preparing_heartbeat_at: string | null;
  };

  const { data: staleJobs, error } = await db
    .from('website_enrichment_jobs')
    .select('id, total, created_at, preparing_heartbeat_at')
    .eq('status', 'preparing')
    .or(
      `preparing_heartbeat_at.lt.${olderThanIso},and(preparing_heartbeat_at.is.null,created_at.lt.${olderThanIso})`,
    )
    .limit(100);
  if (error) throw new Error(error.message);

  let published = 0;
  let failed = 0;

  for (const job of (staleJobs ?? []) as PreparingJobRow[]) {
    const { count, error: countError } = await db
      .from('website_enrichment_queue')
      .select('id', { count: 'exact', head: true })
      .eq('job_id', job.id);
    if (countError) throw new Error(countError.message);

    if (count === job.total) {
      let recoverQuery = db
        .from('website_enrichment_jobs')
        .update({ status: 'pending' })
        .eq('id', job.id)
        .eq('status', 'preparing');
      recoverQuery = job.preparing_heartbeat_at
        ? recoverQuery.eq('preparing_heartbeat_at', job.preparing_heartbeat_at)
        : recoverQuery.is('preparing_heartbeat_at', null).lt('created_at', olderThanIso);
      const { data: recovered, error: recoverError } = await recoverQuery
        .select('id')
        .maybeSingle<{ id: string }>();
      if (recoverError) throw new Error(recoverError.message);
      if (recovered) published += 1;
      continue;
    }

    const message = `Website enrichment queue preparation interrupted: ${count ?? 0}/${job.total} rows`;
    let failQuery = db
      .from('website_enrichment_jobs')
      .update({
        status: 'failed',
        error_message: message,
        completed_at: new Date().toISOString(),
      })
      .eq('id', job.id)
      .eq('status', 'preparing');
    failQuery = job.preparing_heartbeat_at
      ? failQuery.eq('preparing_heartbeat_at', job.preparing_heartbeat_at)
      : failQuery.is('preparing_heartbeat_at', null).lt('created_at', olderThanIso);
    const { data: failedJob, error: failError } = await failQuery
      .select('id')
      .maybeSingle<{ id: string }>();
    if (failError) throw new Error(failError.message);
    if (failedJob) failed += 1;
  }

  return { published, failed };
}

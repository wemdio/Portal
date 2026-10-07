import { AsyncLocalStorage } from 'node:async_hooks';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface SearchProbe {
  job_id: string; base_id: string; query: string; locale: 'ru' | 'en'; page: number;
  attempted_at: string | null; results: Array<Record<string, unknown>> | null;
}
export interface SearchLease { job_id: string; token: string; probe: SearchProbe | null }
const execution = new AsyncLocalStorage<SearchLease & { signal: AbortSignal }>();
export class SearchPersistenceError extends Error {}
export function searchExecution(jobId: string) {
  const lease = execution.getStore();
  if (!lease || lease.job_id !== jobId) throw new SearchPersistenceError('Search execution ownership missing');
  lease.signal.throwIfAborted();
  return lease;
}
export function searchExecutionSignal(): AbortSignal | undefined { return execution.getStore()?.signal; }

export async function searchQueueDeadline<T>(work: PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve(work), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SearchPersistenceError('Search queue request timed out')), 10_000);
    })]);
  } catch (error) {
    throw error instanceof SearchPersistenceError ? error : new SearchPersistenceError('Search queue unavailable');
  } finally { clearTimeout(timer); }
}

/** Every entry point (dedicated/legacy worker and DFYB) uses the same DB gate. */
export async function withSearchExecution(db: SupabaseClient, jobId: string | undefined,
  work: (lease: SearchLease) => Promise<void>): Promise<boolean> {
  const { data, error } = await searchQueueDeadline(db.rpc('search_claim_job', { p_job_id: jobId ?? null }));
  if (error) throw new Error(`Search queue unavailable: ${error.message}`);
  if (!data) return false;
  const lease = data as SearchLease;
  const abort = new AbortController();
  let renewing = false;
  const timer = setInterval(() => {
    if (renewing || abort.signal.aborted) return;
    renewing = true;
    void (async () => {
      try {
        const result = await searchQueueDeadline(db.rpc('search_heartbeat', { p_job_id: lease.job_id, p_token: lease.token }));
        if (result.error || result.data !== true) abort.abort(new SearchPersistenceError('Search execution ownership lost'));
      } catch { abort.abort(new SearchPersistenceError('Search execution heartbeat unavailable')); }
      finally { renewing = false; }
    })();
  }, 30_000);
  timer.unref?.();
  try { await execution.run({ ...lease, signal: abort.signal }, () => work(lease)); }
  finally { clearInterval(timer); abort.abort(new SearchPersistenceError('Search execution ended')); }
  return true;
}

export async function saveSearchProgress(db: SupabaseClient, jobId: string, patch: Record<string, unknown>): Promise<void> {
  const lease = searchExecution(jobId);
  const { data, error } = await searchQueueDeadline(db.rpc('search_save_progress', { p_job_id: jobId, p_token: lease.token, p_patch: patch }));
  if (error || data !== true) throw new SearchPersistenceError('Search progress ownership or persistence failed');
}
export async function saveSearchResults(db: SupabaseClient, jobId: string, rows: Array<Record<string, unknown>>): Promise<number> {
  const lease = searchExecution(jobId);
  const { data, error } = await searchQueueDeadline(db.rpc('search_save_results', { p_job_id: jobId, p_token: lease.token, p_rows: rows }));
  if (error || typeof data !== 'number') throw new SearchPersistenceError('Search result ownership or persistence failed');
  return data;
}

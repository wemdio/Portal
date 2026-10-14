import type { SupabaseClient } from '@supabase/supabase-js';

export interface VeJobFailureTransitionInput {
  jobId: string;
  /** Fence retries to the invocation that failed, not a later claim of the job. */
  startedAt: string | null;
  status: 'pending' | 'failed';
  attempts: number;
  error: string;
  finishedAt: string | null;
  runAfter: string;
  updatedAt: string;
  /** Written together with the transition (the interruption counter). */
  payload?: Record<string, unknown>;
}

export interface VeJobFailureTransitionResult {
  transitioned: boolean;
  error: string | null;
}

/**
 * Commits a worker failure only while its claim is still active.
 *
 * Cancellation is a terminal user decision. It can race between the worker's
 * status read and this write, so the transition must be a compare-and-set from
 * `running`; otherwise a retry/final failure could resurrect a cancelled job.
 */
export async function transitionVeJobFailure(
  db: SupabaseClient,
  input: VeJobFailureTransitionInput,
): Promise<VeJobFailureTransitionResult> {
  let write = db
    .from('ve_jobs')
    .update({
      status: input.status,
      attempts: input.attempts,
      error: input.error,
      finished_at: input.finishedAt,
      run_after: input.runAfter,
      updated_at: input.updatedAt,
      ...(input.payload ? { payload: input.payload } : {}),
    })
    .eq('id', input.jobId)
    .eq('status', 'running');
  write = input.startedAt === null ? write.is('started_at', null) : write.eq('started_at', input.startedAt);
  const { data, error } = await write
    .select('id')
    .abortSignal(AbortSignal.timeout(10_000))
    .maybeSingle();
  if (data || error) return { transitioned: Boolean(data), error: error?.message ?? null };
  // The first write may have committed and only its response was lost. Resume
  // the remaining bookkeeping, without incrementing attempts or reviving a
  // cancelled/newer invocation. The pool retains the base/project lock here.
  let read = db.from('ve_jobs').select('status,attempts,error').eq('id', input.jobId);
  read = input.startedAt === null ? read.is('started_at', null) : read.eq('started_at', input.startedAt);
  const { data: saved, error: readError } = await read.abortSignal(AbortSignal.timeout(10_000)).maybeSingle();
  return {
    transitioned: Boolean(saved && saved.status === input.status && saved.attempts === input.attempts && saved.error === input.error),
    error: readError?.message ?? null,
  };
}

/** Retry bookkeeping only. The caller keeps its queue lock and never replays
 * a stage or provider request here. Shutdown leaves the checkpoint to startup. */
export async function retryVeJobFinalization(options: {
  save: () => Promise<void>;
  shouldStop: () => boolean;
  onError: (error: unknown) => void;
}): Promise<void> {
  let failures = 0;
  while (!options.shouldStop()) {
    try { await options.save(); return; }
    catch (error) { options.onError(error); }
    if (options.shouldStop()) return;
    const delay = Math.min(5_000 * 2 ** Math.min(failures++, 3), 30_000);
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
}

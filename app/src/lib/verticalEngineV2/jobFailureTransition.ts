import type { SupabaseClient } from '@supabase/supabase-js';

export interface VeJobFailureTransitionInput {
  jobId: string;
  status: 'pending' | 'failed';
  attempts: number;
  error: string;
  finishedAt: string | null;
  runAfter: string;
  updatedAt: string;
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
  const { data, error } = await db
    .from('ve_jobs')
    .update({
      status: input.status,
      attempts: input.attempts,
      error: input.error,
      finished_at: input.finishedAt,
      run_after: input.runAfter,
      updated_at: input.updatedAt,
    })
    .eq('id', input.jobId)
    .eq('status', 'running')
    .select('id')
    .maybeSingle();

  return {
    transitioned: Boolean(data),
    error: error?.message ?? null,
  };
}

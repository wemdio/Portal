import type { VeJob } from './types';
import type { VeStageContext } from './stages/shared';

export type VePreparationChildTable = 'base_constructor_jobs' | 'parser_jobs' | 'google_maps_jobs';

/** The same database lock protects child insertion and an explicit pause.
 * A late/ambiguous request cannot create an orphan or replay an existing child. */
export async function enqueueVePreparationChild(
  ctx: VeStageContext, table: VePreparationChildTable, row: Record<string, unknown>, job = ctx.parentJob,
): Promise<string> {
  ctx.signal?.throwIfAborted();
  if (!job) throw new Error('VE preparation child requires its parent job');
  const { data, error } = await ctx.supabase.rpc('ve_enqueue_preparation_child', {
    p_parent_job_id: job.id, p_parent_started_at: job.started_at ?? null, p_kind: table, p_record: row,
  });
  ctx.signal?.throwIfAborted();
  if (error || typeof data !== 'string' || !data) {
    throw new Error(`VE preparation child enqueue: ${error?.message ?? 'missing child identity'}`);
  }
  return data;
}

export type VePreparationParentJob = Pick<VeJob, 'id' | 'started_at'>;

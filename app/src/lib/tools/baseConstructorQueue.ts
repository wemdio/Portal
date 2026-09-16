import type { SupabaseClient } from '@supabase/supabase-js';
import { isSmallConstructorJob } from './baseConstructorCapacity';

export type ConstructorQueue = 'shared' | 'manual';

export function constructorQueue(value: string | undefined): ConstructorQueue {
  if (!value || value === 'shared') return 'shared';
  if (value === 'manual') return 'manual';
  throw new Error('Invalid BASE_CONSTRUCTOR_QUEUE');
}

/** Called only with a child ID read from a trusted parent checkpoint, never a filename. */
export async function markAutomatedConstructor(db: SupabaseClient, childId: string): Promise<void> {
  const { error } = await db.from('base_constructor_jobs').update({ workload_origin: 'automation' })
    .eq('id', childId).or('workload_origin.is.null,workload_origin.eq.manual');
  if (error) throw new Error(`Constructor origin save: ${error.message}`);
}

/** Unknown legacy/rolling-deploy jobs count conservatively; only trusted automation is exempt. */
export async function countActiveManualConstructorJobs(db: SupabaseClient, userId: string): Promise<number> {
  const { count, error } = await db.from('base_constructor_jobs').select('id', { count: 'exact', head: true })
    .eq('user_id', userId).in('status', ['pending', 'processing'])
    .or('workload_origin.is.null,workload_origin.eq.manual');
  if (error || count === null) throw new Error('Не удалось проверить очередь ручных баз. Повторите попытку.');
  return count;
}

export async function nextSmallConstructor(db: SupabaseClient, staleBefore?: string, pool: ConstructorQueue = 'shared'): Promise<{ id: string } | null> {
  for (const validationOnly of [true, false]) {
    let query = db.from('base_constructor_jobs').select('id, initial_row_count, selected_steps, step_config')
      .eq('status', staleBefore ? 'processing' : 'pending').gt('initial_row_count', 0).lte('initial_row_count', 200);
    if (pool === 'manual') query = query.eq('workload_origin', 'manual');
    query = validationOnly ? query.eq('selected_steps->>0', 'validate_emails')
      : query.eq('step_config->>queue_class', 'interactive_preview');
    if (staleBefore) query = query.lt('started_at', staleBefore);
    const { data, error } = await query.order(staleBefore ? 'started_at' : 'created_at', { ascending: true })
      .order('id', { ascending: true }).limit(100);
    if (error) throw new Error(`Constructor small queue read: ${error.message}`);
    const eligible = data?.find(isSmallConstructorJob);
    if (eligible) return { id: eligible.id };
  }
  return null;
}

/** Alternate short/interactive work with FIFO, including under sustained load. */
export async function nextPendingConstructor(
  db: SupabaseClient, preferPreview: boolean, pool: ConstructorQueue = 'shared',
): Promise<{ id: string } | null> {
  if (pool === 'manual') {
    const { data, error } = await db.from('base_constructor_jobs').select('id')
      .eq('status', 'pending').eq('workload_origin', 'manual')
      .order('created_at', { ascending: true }).order('id', { ascending: true }).limit(1).maybeSingle();
    if (error) throw new Error(`Constructor manual queue read: ${error.message}`);
    return data;
  }
  const { data: oldest, error } = await db.from('base_constructor_jobs')
    .select('id, created_at').eq('status', 'pending').order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (error) throw new Error(`Constructor queue read: ${error.message}`);
  if (!oldest || !preferPreview) return oldest;
  // A five-minute FIFO override disabled priority for the entire busy night.
  // Every other successful claim is already FIFO: bulk jobs keep progressing
  // while a small validation-only recovery can unblock its parent preview.
  const { data: validations, error: validationError } = await db.from('base_constructor_jobs')
    .select('id, selected_steps, initial_row_count').eq('status', 'pending')
    .eq('selected_steps->>0', 'validate_emails').lte('initial_row_count', 200)
    .order('created_at', { ascending: true }).order('id', { ascending: true }).limit(20);
  const validation = !validationError && validations?.find((job) =>
    Array.isArray(job.selected_steps) && job.selected_steps.length === 1
    && job.selected_steps[0] === 'validate_emails' && job.initial_row_count > 0);
  if (validation) return validation;
  const { data: preview, error: previewError } = await db.from('base_constructor_jobs')
    .select('id').eq('status', 'pending').eq('step_config->>queue_class', 'interactive_preview')
    .order('created_at', { ascending: true }).limit(1).maybeSingle();
  // Optional priority never stops ordinary queue processing on a read failure.
  return previewError ? oldest : preview ?? oldest;
}

export async function nextStaleConstructor(db: SupabaseClient, cutoffIso: string, pool: ConstructorQueue = 'shared'): Promise<{ id: string } | null> {
  let query = db.from('base_constructor_jobs').select('id').eq('status', 'processing').lt('started_at', cutoffIso);
  if (pool === 'manual') query = query.eq('workload_origin', 'manual');
  const { data, error } = await query.order('started_at', { ascending: true }).order('id', { ascending: true }).limit(1).maybeSingle();
  if (error) throw new Error(`Constructor stale queue read: ${error.message}`);
  return data;
}

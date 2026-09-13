import type { SupabaseClient } from '@supabase/supabase-js';

/** Alternate interactive work with FIFO; old jobs always win after five minutes. */
export async function nextPendingConstructor(
  db: SupabaseClient, preferPreview: boolean, now = Date.now(),
): Promise<{ id: string } | null> {
  const { data: oldest, error } = await db.from('base_constructor_jobs')
    .select('id, created_at').eq('status', 'pending').order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (error) throw new Error(`Constructor queue read: ${error.message}`);
  if (!oldest || !preferPreview) return oldest;
  const createdAt = Date.parse(oldest.created_at ?? '');
  if (!Number.isFinite(createdAt) || now - createdAt >= 5 * 60_000) return oldest;
  const { data: preview, error: previewError } = await db.from('base_constructor_jobs')
    .select('id').eq('status', 'pending').eq('step_config->>queue_class', 'interactive_preview')
    .order('created_at', { ascending: true }).limit(1).maybeSingle();
  // Optional priority never stops ordinary queue processing on a read failure.
  return previewError ? oldest : preview ?? oldest;
}

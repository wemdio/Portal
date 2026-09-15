import type { SupabaseClient } from '@supabase/supabase-js';

/** Alternate short/interactive work with FIFO, including under sustained load. */
export async function nextPendingConstructor(
  db: SupabaseClient, preferPreview: boolean,
): Promise<{ id: string } | null> {
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

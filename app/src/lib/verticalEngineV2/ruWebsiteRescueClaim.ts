import type { SupabaseClient } from '@supabase/supabase-js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

/** One immutable winner per hypothesis. A retry of the winning base recovers
 * its original child ID even if it crashed before saving the parent receipt.
 * Missing migration, ambiguous results and database errors never admit work. */
export async function claimVeRuWebsiteRescue(
  supabase: SupabaseClient,
  input: { projectId: string; hypothesisId: string; baseId: string; proposedId: string },
): Promise<string | null> {
  if (!input || ![input.projectId, input.hypothesisId, input.baseId, input.proposedId].every(isUuid)) return null;
  const projectId = input.projectId.toLowerCase();
  const hypothesisId = input.hypothesisId.toLowerCase();
  const baseId = input.baseId.toLowerCase();
  try {
    const { error: insertError } = await supabase.from('ve_ru_website_rescue_claims').upsert({
      project_id: projectId, hypothesis_id: hypothesisId, base_id: baseId,
      rescue_id: input.proposedId.toLowerCase(),
    }, { onConflict: 'project_id,hypothesis_id', ignoreDuplicates: true });
    if (insertError) return null;
    const { data, error } = await supabase.from('ve_ru_website_rescue_claims')
      .select('base_id, rescue_id').eq('project_id', projectId).eq('hypothesis_id', hypothesisId).maybeSingle();
    if (error || !data || !isUuid(data.base_id) || !isUuid(data.rescue_id)
      || data.base_id.toLowerCase() !== baseId) return null;
    return data.rescue_id.toLowerCase();
  } catch { return null; }
}

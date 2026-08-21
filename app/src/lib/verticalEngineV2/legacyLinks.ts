import type { SupabaseClient } from '@supabase/supabase-js';

import type { VeLegacyCandidate, VeLegacyProjectLink } from './types.legacy';

const LINK_COLUMNS =
  'legacy_he_project_id, verified_by, verified_at, review_notes, backfill_batch_id, created_at';
const CANDIDATE_COLUMNS =
  'id, created_by, name, website_url, status, market, autopilot, created_at';

export type LegacyCandidatesResult =
  | { ok: true; candidates: VeLegacyCandidate[] }
  | { ok: false; message: string };

export type LegacyLinkCreateResult =
  | { ok: true; link: VeLegacyProjectLink }
  | { ok: false; reason: 'not_found' | 'exists' | 'db'; message?: string };

export async function listLegacyCandidates(
  supabase: SupabaseClient,
): Promise<LegacyCandidatesResult> {
  const [projectsResponse, linksResponse] = await Promise.all([
    supabase
      .from('he_projects')
      .select(CANDIDATE_COLUMNS)
      .order('created_at', { ascending: false })
      .limit(200),
    supabase.from('ve_legacy_project_links').select('legacy_he_project_id'),
  ]);

  if (projectsResponse.error) {
    return { ok: false, message: projectsResponse.error.message };
  }
  if (linksResponse.error) {
    return { ok: false, message: linksResponse.error.message };
  }

  const linkedIds = new Set(
    (linksResponse.data ?? [])
      .map((row) => row.legacy_he_project_id)
      .filter((id): id is string => typeof id === 'string'),
  );

  const candidates = ((projectsResponse.data ?? []) as Array<Record<string, unknown>>).map(
    (project): VeLegacyCandidate => ({
      id: String(project.id),
      created_by: typeof project.created_by === 'string' ? project.created_by : null,
      name: String(project.name ?? ''),
      website_url: String(project.website_url ?? ''),
      status: String(project.status ?? ''),
      market: typeof project.market === 'string' ? project.market : null,
      autopilot: typeof project.autopilot === 'boolean' ? project.autopilot : null,
      created_at: typeof project.created_at === 'string' ? project.created_at : null,
      linked: linkedIds.has(String(project.id)),
    }),
  );

  return { ok: true, candidates };
}

export async function createLegacyProjectLink(
  supabase: SupabaseClient,
  input: {
    projectId: string;
    verifiedBy: string;
    reviewNotes: string | null;
    backfillBatchId: string | null;
  },
): Promise<LegacyLinkCreateResult> {
  const { data: project, error: projectError } = await supabase
    .from('he_projects')
    .select('id')
    .eq('id', input.projectId)
    .maybeSingle();
  if (projectError) return { ok: false, reason: 'db', message: projectError.message };
  if (!project) return { ok: false, reason: 'not_found' };

  const { data: existing, error: existingError } = await supabase
    .from('ve_legacy_project_links')
    .select('legacy_he_project_id')
    .eq('legacy_he_project_id', input.projectId)
    .maybeSingle();
  if (existingError) return { ok: false, reason: 'db', message: existingError.message };
  if (existing) return { ok: false, reason: 'exists' };

  const { data: link, error: insertError } = await supabase
    .from('ve_legacy_project_links')
    .insert({
      legacy_he_project_id: input.projectId,
      verified_by: input.verifiedBy,
      review_notes: input.reviewNotes,
      backfill_batch_id: input.backfillBatchId,
    })
    .select(LINK_COLUMNS)
    .single();

  if (insertError || !link) {
    return {
      ok: false,
      reason: 'db',
      message: insertError?.message ?? 'Legacy link insert returned no data',
    };
  }
  return { ok: true, link: link as VeLegacyProjectLink };
}

export async function removeLegacyProjectLink(
  supabase: SupabaseClient,
  projectId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { error } = await supabase
    .from('ve_legacy_project_links')
    .delete()
    .eq('legacy_he_project_id', projectId);
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

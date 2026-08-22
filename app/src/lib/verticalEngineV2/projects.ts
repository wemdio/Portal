import type { SupabaseClient } from '@supabase/supabase-js';

import type { VeProject } from './types';

const PROJECT_COLUMNS =
  'id, created_by, name, website_url, status, created_at, updated_at';

export type VeProjectsResult =
  | { ok: true; projects: VeProject[] }
  | { ok: false; message: string };

export type VeProjectCreateResult =
  | { ok: true; project: VeProject }
  | { ok: false; message: string };

export async function listVeProjects(
  supabase: SupabaseClient,
): Promise<VeProjectsResult> {
  const { data, error } = await supabase
    .from('ve_projects')
    .select(PROJECT_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) return { ok: false, message: error.message };
  return { ok: true, projects: (data ?? []) as VeProject[] };
}

export async function createVeProject(
  supabase: SupabaseClient,
  input: { createdBy: string; name: string; websiteUrl: string },
): Promise<VeProjectCreateResult> {
  const { data, error } = await supabase
    .from('ve_projects')
    .insert({
      created_by: input.createdBy,
      name: input.name,
      website_url: input.websiteUrl,
      status: 'draft',
    })
    .select(PROJECT_COLUMNS)
    .single();

  if (error || !data) {
    return { ok: false, message: error?.message ?? 'Project insert returned no data' };
  }
  return { ok: true, project: data as VeProject };
}

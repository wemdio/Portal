import type { SupabaseClient } from '@supabase/supabase-js';

export interface VeOutreachSetup {
  project_id: string;
  selected_hypothesis_ids: string[];
  approved_bases: Record<string, { template_id: string; revision: string; approved_at: string; approved_by: string }>;
  language: 'ru' | 'en' | 'pl';
  revision: number;
}
export interface VeOutreachPreparation {
  project_id: string; hypothesis_id: string; base_id: string | null; template_id: string | null;
  status: 'pending' | 'collecting' | 'generating' | 'ready' | 'error';
  language: 'ru' | 'en' | 'pl'; last_error: string | null;
}
export interface VeOutreachSetupResponse {
  setup: VeOutreachSetup;
  preparations: VeOutreachPreparation[];
  reviews: Record<string, { template_id: string; revision: string }>;
  error?: string;
}

/** A read does not create a setup or launch a paid job. */
export async function loadVeOutreachSetup(db: SupabaseClient, projectId: string): Promise<VeOutreachSetupResponse> {
  const [project, setupResult, prepResult] = await Promise.all([
    db.from('ve_projects').select('id').eq('id', projectId).maybeSingle(),
    db.from('ve_outreach_setups').select('*').eq('project_id', projectId).maybeSingle(),
    db.from('ve_outreach_preparations')
      .select('project_id,hypothesis_id,base_id,template_id,status,language,last_error').eq('project_id', projectId),
  ]);
  for (const result of [project, setupResult, prepResult]) if (result.error) throw new Error(result.error.message);
  if (!project.data) throw new Error('Проект не найден');
  const setup: VeOutreachSetup = setupResult.data ?? {
    project_id: projectId, selected_hypothesis_ids: [], approved_bases: {}, language: 'ru', revision: 1,
  };
  const preparations = (prepResult.data ?? []) as VeOutreachPreparation[];
  const reviews: VeOutreachSetupResponse['reviews'] = {};
  for (const p of preparations) {
    if (p.status !== 'ready' || !p.base_id || !p.template_id || !setup.selected_hypothesis_ids.includes(p.hypothesis_id)) continue;
    const { data, error } = await db.rpc('ve_contact_supply_preview_revision', { p_template_id: p.template_id });
    if (error) throw new Error(error.message);
    if (typeof data === 'string') reviews[p.base_id] = { template_id: p.template_id, revision: data };
  }
  return { setup, preparations, reviews };
}

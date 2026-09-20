import type { SupabaseClient } from '@supabase/supabase-js';

export interface VeOutreachSetup {
  project_id: string;
  selected_hypothesis_ids: string[];
  approved_bases: Record<string, { template_id: string; revision: string; approved_at: string; approved_by: string }>;
  language: 'ru' | 'en' | 'pl';
  revision: number;
  /** Addresses of one company taken into work; null = no limit. */
  max_emails_per_company?: number | null;
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

export interface VeContactReprojectionOutcome { queued: number; pending: number }

/**
 * Hand bases whose applied "addresses per company" limit is out of date to the
 * worker. The RPC decides per base and refuses anything it must not touch
 * (launched, planned, busy, loosened); a base it cannot serve right now keeps
 * the mismatch and is picked up by the worker sweep later, so nothing is lost.
 * Selection uses plain columns only: `collect_info` of a VE2 base is megabytes.
 */
export async function enqueueVeContactReprojections(
  db: SupabaseClient, scope: { projectId?: string; limit?: number } = {},
): Promise<VeContactReprojectionOutcome> {
  const outcome: VeContactReprojectionOutcome = { queued: 0, pending: 0 };
  let ids: string[] = [];
  if (scope.projectId) {
    const { data, error } = await db.from('ve_bases').select('id,max_emails_per_company,contact_cap_applied')
      .eq('project_id', scope.projectId).eq('source', 'auto').eq('status', 'analyzed')
      .not('hypothesis_id', 'is', null).not('max_emails_per_company', 'is', null)
      .order('updated_at', { ascending: false }).limit(scope.limit ?? 50);
    if (error) return outcome;
    ids = ((data ?? []) as Array<{ id: string; max_emails_per_company: number | null; contact_cap_applied: number | null }>)
      .filter((base) => base.contact_cap_applied === null || (base.max_emails_per_company ?? 0) < base.contact_cap_applied)
      .map((base) => base.id);
  } else {
    const { data, error } = await db.rpc('ve_pending_contact_reprojections', { p_limit: scope.limit ?? 25 });
    if (error) return outcome;
    ids = (Array.isArray(data) ? data : []).map((row) => typeof row === 'string' ? row : String((row as { id?: unknown })?.id ?? ''))
      .filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  }
  for (const id of ids) {
    const result = await db.rpc('ve_enqueue_contact_reprojection', { p_base_id: id });
    if (!result.error && (result.data as { queued?: boolean } | null)?.queued === true) outcome.queued += 1;
    else outcome.pending += 1;
  }
  return outcome;
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

/**
 * Автоподъём баз, легших на ВРЕМЕННОМ сбое провайдера (моргнул Serper, 429,
 * таймаут). Пустой баланс, неверный ключ и отмену пользователем не трогает —
 * их повтор бессмысленен или отменяет решение специалиста. Все проверки и
 * счётчик попыток живут в RPC, чтобы гонка с воркером не подняла базу дважды.
 */
export async function autoResumeVeTransientPreparations(
  db: SupabaseClient, scope: { limit?: number } = {},
): Promise<{ resumed: number }> {
  const { data, error } = await db.rpc('ve_auto_resume_transient_preparations', { p_limit: scope.limit ?? 10 });
  if (error) throw new Error(error.message);
  return { resumed: typeof data === 'number' && Number.isSafeInteger(data) && data > 0 ? data : 0 };
}

/**
 * Постановка research-пайплайна «Движка вертикалей»: воркер сам выстраивает
 * цепочку стадий, здесь ставится только первая (site_profile).
 *
 * Вынесено из POST api/tools/vertical-engine-v2/projects/[id]/research —
 * клиентский ENG-контур ставит research так же (и сразу при создании проекта).
 * Одновременно может идти только один research-прогон: при активной
 * research-стадии — conflict.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const VE_RESEARCH_STAGES = [
  'site_profile',
  'competitors',
  'brand_cloud',
  'hypotheses',
  'evidence',
  'clustering',
];

export type VeResearchEnqueueResult =
  | { ok: true; job: Record<string, unknown> }
  | { ok: false; reason: 'conflict' | 'db'; message?: string };

/**
 * Поставить джобу site_profile и переключить проект в 'researching'.
 * Дедуп: pending/running джоба любой research-стадии этого проекта → conflict,
 * новую не создаём.
 */
export async function enqueueVeResearchJob(
  supabase: SupabaseClient,
  projectId: string,
): Promise<VeResearchEnqueueResult> {
  const { data: active, error: activeErr } = await supabase
    .from('ve_jobs')
    .select('id')
    .eq('project_id', projectId)
    .in('stage', VE_RESEARCH_STAGES)
    .in('status', ['pending', 'running'])
    .limit(1);
  if (activeErr) return { ok: false, reason: 'db', message: activeErr.message };
  if ((active ?? []).length > 0) {
    return { ok: false, reason: 'conflict' };
  }

  const { data: job, error: jobErr } = await supabase
    .from('ve_jobs')
    .insert({ project_id: projectId, stage: 'site_profile', status: 'pending', payload: {} })
    .select()
    .single();
  if (jobErr || !job) {
    return { ok: false, reason: 'db', message: jobErr?.message ?? 'enqueue failed' };
  }

  const { error: updErr } = await supabase
    .from('ve_projects')
    .update({ status: 'researching', error: null })
    .eq('id', projectId);
  if (updErr) {
    return { ok: false, reason: 'db', message: updErr.message };
  }

  return { ok: true, job: job as Record<string, unknown> };
}

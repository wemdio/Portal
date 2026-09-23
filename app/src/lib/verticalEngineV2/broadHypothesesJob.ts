/**
 * Постановка задачи «Добавить широкие гипотезы» в уже исследованный проект.
 * Модель вызывает воркер (стадия broad_hypotheses), здесь — только проверки
 * и строка ve_jobs. Пока задача идёт, вторая не ставится: повторное нажатие
 * возвращает уже идущую. Одновременный запуск исследования отсекает тот же
 * частичный уникальный индекс в БД (ve_jobs_one_active_research_start).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  VE_BROAD_HYPOTHESES_MAX,
  VE_BROAD_HYPOTHESES_STAGE,
  VE_BROAD_RESEARCH_BUSY_TEXT,
  countActiveBroadHypotheses,
} from './broadHypotheses';
import { VE_RESEARCH_STAGES } from './researchJob';

export type VeBroadHypothesesEnqueueResult =
  | { ok: true; job: Record<string, unknown>; existing: boolean }
  | { ok: false; reason: 'not_found' | 'busy' | 'not_ready' | 'limit' | 'db'; message: string };

const ACTIVE = ['pending', 'running'];

async function activeBroadJob(supabase: SupabaseClient, projectId: string) {
  return supabase
    .from('ve_jobs')
    .select('*')
    .eq('project_id', projectId)
    .eq('stage', VE_BROAD_HYPOTHESES_STAGE)
    .in('status', ACTIVE)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
}

export async function enqueueVeBroadHypothesesJob(
  supabase: SupabaseClient,
  projectId: string,
): Promise<VeBroadHypothesesEnqueueResult> {
  const { data: project, error: projectError } = await supabase
    .from('ve_projects')
    .select('id, status')
    .eq('id', projectId)
    .maybeSingle();
  if (projectError) return { ok: false, reason: 'db', message: projectError.message };
  if (!project) return { ok: false, reason: 'not_found', message: 'Проект не найден' };

  const running = await activeBroadJob(supabase, projectId);
  if (running.error) return { ok: false, reason: 'db', message: running.error.message };
  if (running.data) return { ok: true, job: running.data as Record<string, unknown>, existing: true };

  const { data: research, error: researchError } = await supabase
    .from('ve_jobs')
    .select('id')
    .eq('project_id', projectId)
    .in('stage', VE_RESEARCH_STAGES)
    .in('status', ACTIVE)
    .limit(1);
  if (researchError) return { ok: false, reason: 'db', message: researchError.message };
  if ((research ?? []).length > 0 || (project as { status?: string }).status === 'researching') {
    return { ok: false, reason: 'busy', message: VE_BROAD_RESEARCH_BUSY_TEXT };
  }

  const [verticals, hypotheses] = await Promise.all([
    supabase.from('ve_verticals').select('id').eq('project_id', projectId).limit(1),
    supabase.from('ve_hypotheses').select('broad, status').eq('project_id', projectId).eq('broad', true),
  ]);
  if (verticals.error) return { ok: false, reason: 'db', message: verticals.error.message };
  if (hypotheses.error) return { ok: false, reason: 'db', message: hypotheses.error.message };
  if (!(verticals.data ?? []).length) {
    return { ok: false, reason: 'not_ready', message: 'Сначала проведите исследование проекта: широкие гипотезы добавляются к готовым вертикалям' };
  }
  if (countActiveBroadHypotheses(hypotheses.data ?? []) >= VE_BROAD_HYPOTHESES_MAX) {
    return { ok: false, reason: 'limit', message: `В проекте уже ${VE_BROAD_HYPOTHESES_MAX} широких гипотез — это предел` };
  }

  const { data: job, error: jobError } = await supabase
    .from('ve_jobs')
    .insert({ project_id: projectId, stage: VE_BROAD_HYPOTHESES_STAGE, status: 'pending', payload: {} })
    .select()
    .single();
  if (jobError?.code === '23505') {
    // Параллельный запрос успел раньше: такое же нажатие — отдаём его задачу,
    // иначе это запуск исследования.
    const raced = await activeBroadJob(supabase, projectId);
    if (raced.error) return { ok: false, reason: 'db', message: raced.error.message };
    if (raced.data) return { ok: true, job: raced.data as Record<string, unknown>, existing: true };
    return { ok: false, reason: 'busy', message: VE_BROAD_RESEARCH_BUSY_TEXT };
  }
  if (jobError?.code === '23514') {
    return { ok: false, reason: 'db', message: 'Действие пока недоступно: не применено обновление базы данных' };
  }
  if (jobError || !job) return { ok: false, reason: 'db', message: jobError?.message ?? 'Не удалось поставить задачу' };
  return { ok: true, job: job as Record<string, unknown>, existing: false };
}

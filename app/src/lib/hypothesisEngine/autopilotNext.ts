/**
 * Автопилот ENG-кабинета «Движка вертикалей»: дочейн конвейера
 * «выбрал вертикали → одна кнопка → всё само».
 *
 * Вызывается воркером (worker/hypothesisEngine.ts) ПОСЛЕ done-апдейта джобы и
 * enqueueNextResearchStage, под try/catch воркера: сбой постановки followup
 * не должен ронять уже завершённую джобу.
 *
 * Работает ТОЛЬКО при he_projects.autopilot=true (флаг ставит
 * POST /api/client/eng/projects/[id]/autopilot): ручной RU-режим
 * (autopilot=false) здесь никогда ничего не ставит.
 *
 * Правила:
 *  - chain done        → сборка базы вертикали (enqueueHeBaseCollect, лимит
 *                        AUTOPILOT_BASE_LIMIT, accepted-гипотезы вертикали;
 *                        пустой список → null = по всем). Сама base_collect в
 *                        не-refill режиме завершает базу в 'analyzing' и ставит
 *                        base_analyze — это звено конвейера уже автоматично;
 *  - base_analyze done → генерация 85/15 шаблона (he_jobs stage='template',
 *                        дедуп активных template-джоб этой базы), база обязана
 *                        быть 'analyzed';
 *  - всё остальное     → no-op.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { HeJob } from './types';
import { enqueueHeBaseCollect } from './baseCollectEnqueue';

/**
 * Лимит строк авто-сборки автопилота — 2000, как дефолт ручной кнопки
 * «Collect base» кабинета: полный цикл collect → construct → analyze укладывается
 * в разумное время; 10000 остаётся осознанным ручным выбором.
 */
export const AUTOPILOT_BASE_LIMIT = 2000;

export type AutopilotFollowup = 'enqueued' | 'existing' | 'skipped';

export interface AutopilotFollowupsResult {
  /** Итог после chain done (нет ключа — стадия не chain). */
  collect?: AutopilotFollowup;
  /** Итог после base_analyze done (нет ключа — стадия не base_analyze). */
  template?: AutopilotFollowup;
}

/** chain done → постановка сборки базы вертикали. */
async function afterChainDone(supabase: SupabaseClient, job: HeJob): Promise<AutopilotFollowup> {
  const verticalId = typeof job.payload?.vertical_id === 'string' ? job.payload.vertical_id : null;
  if (!verticalId) return 'skipped';

  // Имя вертикали — в filename авто-базы; accepted-гипотезы — вход плана сборки.
  const [verticalRes, hypothesesRes] = await Promise.all([
    supabase.from('he_verticals').select('id, name').eq('id', verticalId).maybeSingle(),
    supabase.from('he_hypotheses').select('id').eq('vertical_id', verticalId).eq('status', 'accepted'),
  ]);
  if (verticalRes.error) throw new Error(`autopilot vertical read: ${verticalRes.error.message}`);
  if (hypothesesRes.error) throw new Error(`autopilot hypotheses read: ${hypothesesRes.error.message}`);
  if (!verticalRes.data) return 'skipped';

  const hypothesisIds = (hypothesesRes.data ?? [])
    .map((h) => (h as { id?: string }).id)
    .filter((v): v is string => typeof v === 'string' && v.length > 0);

  const res = await enqueueHeBaseCollect(supabase, {
    verticalId,
    projectId: job.project_id,
    verticalName: (verticalRes.data as { name?: string }).name ?? 'vertical',
    limit: AUTOPILOT_BASE_LIMIT,
    hypothesisIds: hypothesisIds.length > 0 ? hypothesisIds : null,
  });
  if (!res.ok) throw new Error(`autopilot base_collect enqueue: ${res.message}`);
  return res.created ? 'enqueued' : 'existing';
}

/** base_analyze done → постановка генерации шаблона по проанализированной базе. */
async function afterBaseAnalyzeDone(supabase: SupabaseClient, job: HeJob): Promise<AutopilotFollowup> {
  const baseId = typeof job.payload?.base_id === 'string' ? job.payload.base_id : null;
  if (!baseId) return 'skipped';

  const { data: base, error: baseErr } = await supabase
    .from('he_bases')
    .select('id, status')
    .eq('id', baseId)
    .maybeSingle();
  if (baseErr) throw new Error(`autopilot base read: ${baseErr.message}`);
  // Шаблон строится только по проанализированной базе (контракт ручной кнопки).
  if (!base || (base as { status?: string }).status !== 'analyzed') return 'skipped';

  // Дедуп — как у ручного роута bases/[id]/template: активная template-джоба
  // этой базы уже есть → новую не ставим.
  const { data: active, error: activeErr } = await supabase
    .from('he_jobs')
    .select('id, payload')
    .eq('project_id', job.project_id)
    .eq('stage', 'template')
    .in('status', ['pending', 'running']);
  if (activeErr) throw new Error(`autopilot template dedup read: ${activeErr.message}`);
  const existing = (active ?? []).find(
    (j) => (j.payload as { base_id?: string } | null)?.base_id === baseId,
  );
  if (existing) return 'existing';

  const { error: jobErr } = await supabase.from('he_jobs').insert({
    project_id: job.project_id,
    stage: 'template',
    status: 'pending',
    payload: { base_id: baseId },
  });
  if (jobErr) throw new Error(`autopilot template enqueue: ${jobErr.message}`);
  return 'enqueued';
}

/**
 * Дочейнить следующую стадию конвейера автопилота после done-джобы.
 * Бросает ошибку наверх — воркер логирует и продолжает (done уже записан).
 */
export async function enqueueAutopilotFollowups(
  supabase: SupabaseClient,
  job: HeJob,
): Promise<AutopilotFollowupsResult> {
  // Только входные точки конвейера; research-стадии ведёт enqueueNextResearchStage,
  // base_collect сама ставит base_analyze, template — терминальная.
  if (job.stage !== 'chain' && job.stage !== 'base_analyze') return {};

  const { data: project, error: projErr } = await supabase
    .from('he_projects')
    .select('id, autopilot')
    .eq('id', job.project_id)
    .maybeSingle();
  if (projErr) throw new Error(`autopilot project read: ${projErr.message}`);
  if (!project || (project as { autopilot?: boolean }).autopilot !== true) return {};

  return job.stage === 'chain'
    ? { collect: await afterChainDone(supabase, job) }
    : { template: await afterBaseAnalyzeDone(supabase, job) };
}

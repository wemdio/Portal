/**
 * Постановка research-пайплайна «Движка вертикалей»: воркер сам выстраивает
 * цепочку стадий, здесь ставится только первая (site_profile).
 *
 * Вынесено из POST api/tools/hypothesis-engine/projects/[id]/research —
 * клиентский ENG-контур ставит research так же (и сразу при создании проекта).
 * Одновременно может идти только один research-прогон: при активной
 * research-стадии — conflict.
 *
 * Дедуп двухслойный. Чтение ниже отсекает обычный повтор, а гонку двух
 * одновременных запросов (двойной клик, два таба) держит partial unique index
 * `he_jobs_one_active_site_profile`
 * (supabase/migrations/20260929_0002_he_site_profile_active_unique.sql):
 * проигравшая вставка получает 23505 и становится тем же conflict'ом, то есть
 * 409, а не 500 с текстом Postgres. Индекс покрывает ТОЛЬКО стадию
 * site_profile — почему именно её и чем опасен широкий, написано в миграции.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const HE_RESEARCH_STAGES = [
  'site_profile',
  'competitors',
  'brand_cloud',
  'hypotheses',
  'evidence',
  'clustering',
];

export type HeResearchEnqueueResult =
  | { ok: true; job: Record<string, unknown> }
  | { ok: false; reason: 'conflict' | 'db'; message?: string };

/**
 * Поставить джобу site_profile и переключить проект в 'researching'.
 * Дедуп: pending/running джоба любой research-стадии этого проекта → conflict,
 * новую не создаём.
 */
export async function enqueueHeResearchJob(
  supabase: SupabaseClient,
  projectId: string,
): Promise<HeResearchEnqueueResult> {
  const { data: active, error: activeErr } = await supabase
    .from('he_jobs')
    .select('id')
    .eq('project_id', projectId)
    .in('stage', HE_RESEARCH_STAGES)
    .in('status', ['pending', 'running'])
    .limit(1);
  if (activeErr) return { ok: false, reason: 'db', message: activeErr.message };
  if ((active ?? []).length > 0) {
    return { ok: false, reason: 'conflict' };
  }

  const { data: job, error: jobErr } = await supabase
    .from('he_jobs')
    .insert({ project_id: projectId, stage: 'site_profile', status: 'pending', payload: {} })
    .select()
    .single();
  // 23505 = unique_violation на he_jobs_one_active_site_profile: параллельный
  // запуск исследования успел раньше. Вставки не произошло, писать и откатывать
  // нечего — отвечаем тем же conflict'ом, что и дедуп-чтение выше, и НЕ трогаем
  // he_projects.status ниже: этот перевод принадлежит победителю. Гонка: на
  // момент нашего ответа он мог ещё не дописать 'researching', поэтому клиент,
  // прочитавший карточку сразу после 409, может увидеть прежний статус —
  // состояние выравнивается за один polling-тик, а вторая запись отсюда
  // затёрла бы чужой прогон.
  // Других уникальных ограничений у he_jobs нет (кроме PK по id с
  // gen_random_uuid()), поэтому код однозначен.
  if (jobErr?.code === '23505') return { ok: false, reason: 'conflict' };
  if (jobErr || !job) {
    return { ok: false, reason: 'db', message: jobErr?.message ?? 'enqueue failed' };
  }

  const { error: updErr } = await supabase
    .from('he_projects')
    .update({ status: 'researching', error: null })
    .eq('id', projectId);
  if (updErr) {
    return { ok: false, reason: 'db', message: updErr.message };
  }

  return { ok: true, job: job as Record<string, unknown> };
}

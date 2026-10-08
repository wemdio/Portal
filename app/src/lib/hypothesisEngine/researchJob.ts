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
  // Код однозначен: остальные уникальные ограничения he_jobs на эту вставку
  // ответить не могут — PK по id с gen_random_uuid(), а partial-индексы
  // 20261008_0001 (одна активная template / base_analyze на базу) стоят на
  // ДРУГИХ стадиях и строку site_profile в свой предикат не берут.
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

/* ───────────── «Re-run research» удаляет оплаченное: что именно ───────────── */

/**
 * Снимок проекта, по которому решается повторный запуск исследования.
 * Собирает его клиентский роут (api/client/eng/projects/[id]/research); сама
 * функция ниже чистая — без БД и без часов.
 */
export interface EngResearchRerunSnapshot {
  /** Все he_bases проекта: статус и row_count как пришли из БД. */
  bases: ReadonlyArray<{ status?: unknown; row_count?: unknown }>;
  /** Все he_templates вертикалей проекта; launched — heTemplateLaunchMarked. */
  templates: ReadonlyArray<{ launched: boolean }>;
  /** Сколько he_chains вертикалей проекта (status ≠ 'failed'). */
  letterSequences: number;
  /** Активные (pending/running) джобы проекта НЕ research-стадий. */
  activeWork: number;
}

/** Что удалит повторное исследование — числа для 409 и диалога кабинета. */
export interface EngResearchRerunConsequences {
  /** Базы, в которых есть что терять (см. engResearchRerunBlockers). */
  audiences: number;
  /** Сумма row_count этих баз — строки (адреса), а не компании. */
  rows: number;
  templates: number;
  launched_templates: number;
  letter_sequences: number;
  active_jobs: number;
}

/**
 *  - 'free'     — из того, что считает эта функция, удалять нечего, повтор идёт
 *                 как раньше (вокабуляры и досье вертикалей она не считает —
 *                 их клиентский роут сам превращает 'free' в 'confirm',
 *                 RerunVerticalPrep);
 *  - 'confirm'  — удалит оплаченное: 409, повтор только с confirm: true;
 *  - 'busy'     — сейчас идёт работа по вертикалям: отказ даже с confirm;
 *  - 'launched' — у шаблона проекта есть запуск: отказ даже с confirm.
 */
export type EngResearchRerunVerdict = 'free' | 'confirm' | 'busy' | 'launched';

/**
 * ЧТО ДЕЛАЕТ «Re-run research». Последняя research-стадия, clustering
 * (stages/clustering.ts), удаляет ВСЕ he_verticals проекта, и каскадом
 * (on delete cascade) уходит всё, что на них построено:
 *   - he_chains, he_vocab, he_bases, he_templates —
 *     20260724_0001_create_hypothesis_engine.sql (vertical_id … on delete cascade);
 *     he_templates вдобавок каскадом от he_bases (base_id … on delete cascade),
 *     а с шаблоном — его запись о запуске launch_info;
 *   - he_vertical_dossiers — 20260728_0001;
 *   - he_launch_schedule — от he_templates, 20260926_0002;
 *   - курсор каталога — 20260930_0002; очередь перенесённых компаний —
 *     20261004_0001 (и от he_verticals, и от he_bases).
 * То есть повтор молча стирал оплаченные базы, шаблоны и записи о запуске.
 *
 * ПРАВИЛО.
 *  - 'launched' — хоть один шаблон с запуском: кампании живут у рассыльщика, а
 *    удаление записи лишает их достройки, долива и защиты от второго запуска
 *    по тем же людям. Отказ всегда, confirm не принимается.
 *  - 'busy' — идёт работа НЕ research-стадий (цепочка, сборка, анализ, шаблон,
 *    досье, вокабуляр): её цель удалит кластеризация, а до неё работа
 *    продолжает платить, и автопилот ставит следующие платные стадии по
 *    обречённым базам. Отказ даже с confirm — сначала дождаться или
 *    остановить («Cancel all jobs»). Активные research-стадии сюда не входят:
 *    их ловит дедуп enqueueHeResearchJob («уже идёт»).
 *  - 'confirm' — есть что терять: база (кроме упавшей без строк — в ней нет
 *    ничего), шаблон или цепочка писем.
 *  - 'free' — ничего из этого нет.
 *
 * Статусы he_bases перебраны все (he_bases_status_check): uploaded, collecting,
 * analyzing, analyzed — в счёт всегда (строки есть или собираются); failed — в
 * счёт, только если строки есть (row_count > 0): сборка, упавшая после
 * harvest, строки оставляет.
 */
export function engResearchRerunBlockers(snapshot: EngResearchRerunSnapshot): {
  verdict: EngResearchRerunVerdict;
  consequences: EngResearchRerunConsequences;
} {
  let audiences = 0;
  let rows = 0;
  for (const base of snapshot.bases) {
    const rowCount = typeof base.row_count === 'number' && base.row_count > 0 ? base.row_count : 0;
    if (base.status === 'failed' && rowCount === 0) continue;
    audiences += 1;
    rows += rowCount;
  }
  const launchedTemplates = snapshot.templates.filter((t) => t.launched).length;
  const consequences: EngResearchRerunConsequences = {
    audiences,
    rows,
    templates: snapshot.templates.length,
    launched_templates: launchedTemplates,
    letter_sequences: Math.max(0, snapshot.letterSequences),
    active_jobs: Math.max(0, snapshot.activeWork),
  };
  let verdict: EngResearchRerunVerdict = 'free';
  if (launchedTemplates > 0) verdict = 'launched';
  else if (consequences.active_jobs > 0) verdict = 'busy';
  else if (audiences > 0 || consequences.templates > 0 || consequences.letter_sequences > 0) verdict = 'confirm';
  return { verdict, consequences };
}

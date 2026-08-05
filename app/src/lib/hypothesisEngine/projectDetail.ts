/**
 * Деталка проекта «Движка вертикалей»: гипотезы, вертикали, цепочки,
 * вокабуляр, базы, шаблоны, досье вертикалей, банк кейсов и последние jobs.
 *
 * Вынесено из GET api/tools/hypothesis-engine/projects/[id] — та же сборка
 * нужна клиентскому ENG-контуру (api/client/eng/projects/[id]), который
 * дополнительно скоупит проект по владельцу (scopeCreatedBy).
 *
 * Чейн/вокаб/шаблоны привязаны к вертикалям/базам, поэтому догружаются второй
 * волной по id вертикалей; досье и кейсы имеют project_id и идут первой волной.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// Без data — тяжёлое jsonb-поле, деталка проекта его не тянет. sample_rows
// (≤30 строк, серверный кап при записи) и columns лёгкие: шаг «База» рисует
// по ним превью первых строк на карточке. source/collect_info — прогресс-карта
// авто-сборки, бейдж «авто» и состояние retry.
export const HE_BASE_LIST_COLUMNS =
  'id, vertical_id, filename, row_count, status, analysis, source, collect_info, columns, sample_rows, created_at';
// payload нужен клиенту, чтобы привязать джобу к вертикали (payload.vertical_id) —
// иначе чужая dossier-джоба показывала бы busy/error на карточке другой вертикали.
export const HE_JOB_LIST_COLUMNS = 'id, stage, status, error, attempts, started_at, finished_at, payload, progress';
// Досье вертикалей: data — объективные счётчики сегмента, нужна на карточке.
export const HE_DOSSIER_LIST_COLUMNS = 'id, vertical_id, status, data, error';
// Банк кейсов: БЕЗ text — полный текст кейса тяжёлый, списку хватает карточки.
export const HE_CASE_LIST_COLUMNS = 'id, source, filename, industry, client_type, task, metrics, result, created_at';

export interface HeProjectDetail {
  project: Record<string, unknown>;
  hypotheses: unknown[];
  verticals: unknown[];
  chains: unknown[];
  vocabs: unknown[];
  bases: unknown[];
  templates: unknown[];
  jobs: unknown[];
  dossiers: unknown[];
  cases: unknown[];
}

export type HeProjectDetailResult =
  | { ok: true; detail: HeProjectDetail }
  | { ok: false; reason: 'not_found' | 'db'; message?: string };

// collect_info.tasks[].harvest — полный предмерж-харвест задачи (до 50k строк
// на задачу): рабочее состояние воркера для cross-requeue, клиенту не нужен.
// Деталка проекта поллится каждые 4с, поэтому вырезаем harvest из ответа —
// иначе каждая база тащит десятки МБ на каждый опрос. Остальное в tasks[]
// (source/status/rows/…) оставляем как есть: по нему рисуется прогресс-карта.
function stripTaskHarvest(base: Record<string, unknown>): Record<string, unknown> {
  const info = base.collect_info as { tasks?: unknown } | null | undefined;
  if (!info || !Array.isArray(info.tasks)) return base;
  const hasHarvest = info.tasks.some(
    (t) => t !== null && typeof t === 'object' && 'harvest' in (t as Record<string, unknown>),
  );
  if (!hasHarvest) return base;
  return {
    ...base,
    collect_info: {
      ...info,
      tasks: info.tasks.map((t) => {
        if (t === null || typeof t !== 'object' || !('harvest' in t)) return t;
        const clone = { ...(t as Record<string, unknown>) };
        delete clone.harvest;
        return clone;
      }),
    },
  };
}

/**
 * Загрузить проект и все его артефакты. scopeCreatedBy — скоуп владельца
 * (клиентский контур): проект с чужим created_by отвечает not_found,
 * существование чужого проекта не раскрываем.
 */
export async function loadHeProjectDetail(
  supabase: SupabaseClient,
  projectId: string,
  opts: { scopeCreatedBy?: string } = {},
): Promise<HeProjectDetailResult> {
  let projectQuery = supabase
    .from('he_projects')
    .select('*')
    .eq('id', projectId);
  if (opts.scopeCreatedBy) {
    projectQuery = projectQuery.eq('created_by', opts.scopeCreatedBy);
  }
  const { data: project, error: projErr } = await projectQuery.single();
  if (projErr) {
    return {
      ok: false,
      reason: projErr.code === 'PGRST116' ? 'not_found' : 'db',
      message: projErr.message,
    };
  }

  const [hypothesesRes, verticalsRes, basesRes, jobsRes, dossiersRes, casesRes] = await Promise.all([
    supabase
      .from('he_hypotheses')
      .select('*')
      .eq('project_id', projectId)
      .order('tier', { ascending: true })
      .order('potential_pct', { ascending: false }),
    supabase
      .from('he_verticals')
      .select('*')
      .eq('project_id', projectId)
      .order('rank', { ascending: true }),
    supabase
      .from('he_bases')
      .select(HE_BASE_LIST_COLUMNS)
      .eq('project_id', projectId)
      .order('created_at', { ascending: false }),
    supabase
      .from('he_jobs')
      .select(HE_JOB_LIST_COLUMNS)
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(30),
    supabase
      .from('he_vertical_dossiers')
      .select(HE_DOSSIER_LIST_COLUMNS)
      .eq('project_id', projectId)
      .order('created_at', { ascending: false }),
    supabase
      .from('he_cases')
      .select(HE_CASE_LIST_COLUMNS)
      .eq('project_id', projectId)
      .order('created_at', { ascending: false }),
  ]);

  for (const res of [hypothesesRes, verticalsRes, basesRes, jobsRes, dossiersRes, casesRes]) {
    if (res.error) return { ok: false, reason: 'db', message: res.error.message };
  }

  const verticals = verticalsRes.data ?? [];
  const verticalIds = verticals.map((v) => v.id as string);

  let chains: unknown[] = [];
  let vocabs: unknown[] = [];
  let templates: unknown[] = [];
  if (verticalIds.length > 0) {
    const [chainsRes, vocabsRes, templatesRes] = await Promise.all([
      supabase
        .from('he_chains')
        .select('*')
        .in('vertical_id', verticalIds)
        .order('created_at', { ascending: false }),
      supabase
        .from('he_vocab')
        .select('*')
        .in('vertical_id', verticalIds)
        .order('created_at', { ascending: false }),
      supabase
        .from('he_templates')
        .select('*')
        .in('vertical_id', verticalIds)
        .order('created_at', { ascending: false }),
    ]);
    for (const res of [chainsRes, vocabsRes, templatesRes]) {
      if (res.error) return { ok: false, reason: 'db', message: res.error.message };
    }
    chains = chainsRes.data ?? [];
    vocabs = vocabsRes.data ?? [];
    templates = templatesRes.data ?? [];
  }

  return {
    ok: true,
    detail: {
      project: project as Record<string, unknown>,
      hypotheses: hypothesesRes.data ?? [],
      verticals,
      chains,
      vocabs,
      bases: (basesRes.data ?? []).map(stripTaskHarvest),
      templates,
      jobs: jobsRes.data ?? [],
      dossiers: dossiersRes.data ?? [],
      cases: casesRes.data ?? [],
    },
  };
}

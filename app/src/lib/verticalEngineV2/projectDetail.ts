/**
 * Деталка проекта «Движка вертикалей»: гипотезы, вертикали, цепочки,
 * вокабуляр, базы, шаблоны, досье вертикалей, банк кейсов и последние jobs.
 *
 * Сборка GET api/tools/vertical-engine-v2/projects/[id]. Только ve_*;
 * клиентский ENG использует отдельный hypothesisEngine/projectDetail.
 *
 * Чейн/вокаб/шаблоны привязаны к вертикалям/базам, поэтому догружаются второй
 * волной по id вертикалей; досье и кейсы имеют project_id и идут первой волной.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { reconcileProjectVerticals } from './actualsReconcile';
import { readContactDeliveryPages } from './contactDeliveryInventory';

// Без data — тяжёлое jsonb-поле, деталка проекта его не тянет. sample_rows
// (≤30 строк, серверный кап при записи) и columns лёгкие: шаг «База» рисует
// по ним превью первых строк на карточке. source/collect_info — прогресс-карта
// авто-сборки, бейдж «авто» и состояние retry.
// error нужен клиенту: с появлением права автопилота НЕ строить базу (проба
// среза, stages/baseCollect) статус 'failed' сам по себе ничего не объясняет —
// без причины отказ выглядит поломкой, а не решением.
export const VE_BASE_LIST_COLUMNS =
  'id, vertical_id, hypothesis_id, filename, row_count, status, error, analysis, source, collect_info, columns, sample_rows, created_at';
// payload нужен клиенту, чтобы привязать джобу к вертикали (payload.vertical_id) —
// иначе чужая dossier-джоба показывала бы busy/error на карточке другой вертикали.
export const VE_JOB_LIST_COLUMNS = 'id, stage, status, error, attempts, started_at, finished_at, payload, progress';
// Досье вертикалей: data — объективные счётчики сегмента, нужна на карточке.
export const VE_DOSSIER_LIST_COLUMNS = 'id, vertical_id, status, data, error';
// Полный сохранённый разбор нужен специалисту для проверки кейса перед письмами.
// Та же проекция используется отдельным cases API, чтобы карточки не теряли поля.
export const VE_CASE_LIST_COLUMNS = 'id, source, filename, industry, client_type, task, metrics, result, text, created_at';

export interface VeProjectDetail {
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

export type VeProjectDetailResult =
  | { ok: true; detail: VeProjectDetail }
  | { ok: false; reason: 'not_found' | 'db'; message?: string };

async function readDetailPages(
  label: string,
  read: Parameters<typeof readContactDeliveryPages<Record<string, unknown>>>[1],
) {
  try {
    return { data: await readContactDeliveryPages(label, read), error: null };
  } catch (error) {
    return { data: null, error: { message: error instanceof Error ? error.message : `${label} read failed` } };
  }
}

// collect_info.tasks[].harvest — полный предмерж-харвест задачи (до 50k строк
// на задачу): рабочее состояние воркера для cross-requeue, клиенту не нужен.
// Деталка проекта поллится каждые 4с, поэтому вырезаем harvest из ответа —
// иначе каждая база тащит десятки МБ на каждый опрос. Остальное в tasks[]
// (source/status/rows/…) оставляем как есть: по нему рисуется прогресс-карта.
// Также удаляем checkpoint исключённых кандидатов; helper используется всеми
// VE2-ответами, возвращающими карточку сборки, включая идемпотентный collect POST.
export function stripTaskHarvest(base: Record<string, unknown>): Record<string, unknown> {
  const info = base.collect_info as { tasks?: unknown; target_checkpoint?: unknown } | null | undefined;
  if (!info) return base;
  const tasks = Array.isArray(info.tasks) ? info.tasks : [];
  const hasHarvest = tasks.some(
    (t) => t !== null && typeof t === 'object' && 'harvest' in (t as Record<string, unknown>),
  );
  if (!hasHarvest && !('target_checkpoint' in info)) return base;
  const publicInfo = { ...info };
  delete publicInfo.target_checkpoint;
  return {
    ...base,
    collect_info: {
      ...publicInfo,
      tasks: tasks.map((t) => {
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
export async function loadVeProjectDetail(
  supabase: SupabaseClient,
  projectId: string,
  opts: { scopeCreatedBy?: string } = {},
): Promise<VeProjectDetailResult> {
  let projectQuery = supabase
    .from('ve_projects')
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
      .from('ve_hypotheses')
      .select('*')
      .eq('project_id', projectId)
      .order('tier', { ascending: true })
      .order('potential_pct', { ascending: false }),
    supabase
      .from('ve_verticals')
      .select('*')
      .eq('project_id', projectId)
      .order('rank', { ascending: true }),
    readDetailPages('project bases', (from, to) => supabase
      .from('ve_bases')
      .select(VE_BASE_LIST_COLUMNS, { count: 'exact' })
      .eq('project_id', projectId)
      // Exclude completed internal batches BEFORE PostgREST applies its page cap.
      // Active supply stays visible to the project-wide collection queue.
      .or('collect_info->>collection_mode.is.null,collect_info->>collection_mode.neq.supply,status.eq.collecting')
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, to)),
    supabase
      .from('ve_jobs')
      .select(VE_JOB_LIST_COLUMNS)
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(30),
    supabase
      .from('ve_vertical_dossiers')
      .select(VE_DOSSIER_LIST_COLUMNS)
      .eq('project_id', projectId)
      .order('created_at', { ascending: false }),
    supabase
      .from('ve_cases')
      .select(VE_CASE_LIST_COLUMNS)
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
        .from('ve_chains')
        .select('*')
        .in('vertical_id', verticalIds)
        .order('created_at', { ascending: false }),
      supabase
        .from('ve_vocab')
        .select('*')
        .in('vertical_id', verticalIds)
        .order('created_at', { ascending: false }),
      readDetailPages('project templates', (from, to) => supabase
        .from('ve_templates')
        .select('*', { count: 'exact' })
        .in('vertical_id', verticalIds)
        .is('supply_batch_id', null)
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to)),
    ]);
    for (const res of [chainsRes, vocabsRes, templatesRes]) {
      if (res.error) return { ok: false, reason: 'db', message: res.error.message };
    }
    chains = chainsRes.data ?? [];
    vocabs = vocabsRes.data ?? [];
    templates = templatesRes.data ?? [];
  }

  // Петля сверки прогноз↔факт: fire-and-forget (best-effort; свежесть
  // замеров и объёмы проверяются внутри, деталку не тормозит).
  void reconcileProjectVerticals(supabase, projectId).catch(() => {});

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

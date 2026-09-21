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

import type { VeAdaptiveCollection } from './adaptiveCollection';
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
// collect_info НЕ берём колонкой целиком: 99,99 % документа — рабочее состояние
// воркера (relevance_reserve, relevance_checkpoint, target_checkpoint,
// tasks[].harvest, search_policy.deferred_rows), которое stripTaskHarvest
// выбрасывала уже ПОСЛЕ материализации ответа. Замер прода 21.09.2026 по
// проекту «Аврора» (17 баз, тот же фильтр, что ниже): 586 878 670 байт при
// пределе строки V8 536 870 888 — Buffer.toString() падал с «Cannot create a
// string longer than 0x1fffffe8 characters», деталка не открывалась трое суток.
// Точечная проекция отдаёт те же ключи за ~77 КБ.
/** Ключи collect_info, которые читает карточка проекта (по коду клиента:
 *  components/vertical-engine-v2/**). Белый список: чего здесь нет — до
 *  клиента не доедет, поэтому новый публичный ключ добавляется и сюда. */
export const VE_BASE_COLLECT_INFO_KEYS = [
  'collection_mode', 'ready_target', 'supply_hold', 'waiting_for_base_id', 'limit',
  'target_progress', 'construct', 'plan', 'estimate', 'stats',
  'relevance_summary', 'company_contact_cap', 'company_name_cleanup', 'company_name_recovery',
  'source_contact_discovery', 'relevance_review_requested', 'validation_retry',
  'hypothesis_id', 'hypothesis_ids', 'hypotheses', 'plan_repair', 'slice_probe',
] as const;
/** tasks[] берём поэлементно: harvest лежит ВНУТРИ элементов, а PostgREST не
 *  умеет вырезать ключ из элементов массива — «взять tasks целиком» значит
 *  снова тянуть harvest (17 МБ на «Авроре»). Жёсткий потолок задач — 6
 *  (schemas.ts: план ≤4, адаптивный реплан ≤2 сверху), замер по всем базам
 *  прода — максимум 4. Слот с индексом VE_BASE_TASK_SLOTS читается как проба
 *  переполнения: усечение должно быть видно в логе, а не молча. */
export const VE_BASE_TASK_SLOTS = 8;
const VE_BASE_TASK_FIELDS = ['source', 'status', 'rows'] as const;
export const VE_BASE_LIST_COLUMNS = [
  'id', 'vertical_id', 'hypothesis_id', 'filename', 'row_count', 'status', 'error',
  'analysis', 'source', 'columns', 'sample_rows', 'created_at', 'updated_at',
  ...VE_BASE_COLLECT_INFO_KEYS.map((key) => `ci_${key}:collect_info->${key}`),
  // search_policy: наружу уходят только version/phase — ровно то, что оставляла
  // stripTaskHarvest. deferred_rows (до 2,5 МБ на базу) не выбираем вовсе.
  'ci_search_policy_version:collect_info->search_policy->version',
  'ci_search_policy_phase:collect_info->search_policy->>phase',
  // adaptive_collection: pending.ready_before — sha256 уже готовых получателей,
  // они никогда не уходят в поллинг. Берём сводку; completed (кап 100 батчей,
  // ≤45 КБ) нужен целиком ради completed_batches и last_batch.
  'ci_adaptive_version:collect_info->adaptive_collection->version',
  'ci_adaptive_switches:collect_info->adaptive_collection->switches',
  'ci_adaptive_note:collect_info->adaptive_collection->>note',
  'ci_adaptive_replan_error:collect_info->adaptive_collection->>replan_error',
  'ci_adaptive_pending_id:collect_info->adaptive_collection->pending->>id',
  'ci_adaptive_completed:collect_info->adaptive_collection->completed',
  // saved_email_recovery: наружу уходит только фаза. attempt_id гарантирован
  // схемой (savedEmailRecovery.ts), поэтому он — признак «состояние есть»;
  // карта checked (до 748 КБ) остаётся в БД.
  'ci_saved_email_attempt_id:collect_info->saved_email_recovery->>attempt_id',
  'ci_saved_email_batch_id:collect_info->saved_email_recovery->batch->>id',
  'ci_saved_email_error:collect_info->saved_email_recovery->>error',
  ...Array.from({ length: VE_BASE_TASK_SLOTS + 1 }, (_, i) => VE_BASE_TASK_FIELDS
    .map((field) => `ci_task_${i}_${field}:collect_info->tasks->${i}->${field}`)).flat(),
].join(', ');
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
// Также удаляем checkpoints исключённых кандидатов и relevance-вердиктов; helper используется всеми
// VE2-ответами, возвращающими карточку сборки, включая идемпотентный collect POST.
export function stripTaskHarvest(base: Record<string, unknown>): Record<string, unknown> {
  const info = base.collect_info as { adaptive_collection?: VeAdaptiveCollection; tasks?: unknown; search_policy?: { version: number; phase: string; deferred_rows?: unknown }; source_contact_recovery?: unknown; preview_pipeline?: unknown; target_checkpoint?: unknown; relevance_checkpoint?: unknown; relevance_reserve?: unknown; saved_email_recovery?: unknown; company_name_checkpoint?: unknown; company_name_recovery?: unknown } | null | undefined;
  if (!info) return base;
  const tasks = Array.isArray(info.tasks) ? info.tasks : [];
  const hasHarvest = tasks.some(
    (t) => t !== null && typeof t === 'object' && 'harvest' in (t as Record<string, unknown>),
  );
  if (!hasHarvest && !('target_checkpoint' in info) && !('relevance_checkpoint' in info) && !('relevance_reserve' in info)
    && !('adaptive_collection' in info) && !('search_policy' in info) && !('source_contact_recovery' in info) && !('saved_email_recovery' in info) && !('company_name_checkpoint' in info) && !('company_name_recovery' in info) && !('preview_pipeline' in info)) return base;
  const publicInfo = { ...info };
  const adaptive = info.adaptive_collection;
  delete publicInfo.adaptive_collection;
  if (info.search_policy) publicInfo.search_policy = { version: info.search_policy.version, phase: info.search_policy.phase };
  delete publicInfo.preview_pipeline;
  const emailRecovery = info.saved_email_recovery && typeof info.saved_email_recovery === 'object'
    ? info.saved_email_recovery as { batch?: unknown; error?: unknown } : null;
  delete publicInfo.target_checkpoint;
  delete publicInfo.relevance_checkpoint;
  delete publicInfo.relevance_reserve;
  delete publicInfo.saved_email_recovery;
  delete publicInfo.source_contact_recovery;
  delete publicInfo.company_name_checkpoint;
  // Recovery marker is needed by the collect button but contains no raw contacts.
  return {
    ...base,
    collect_info: {
      ...publicInfo,
      ...(adaptive ? { adaptive_collection: { version: adaptive.version, switches: adaptive.switches,
        note: adaptive.note, replan_error: adaptive.replan_error, checking_batch: !!adaptive.pending,
        completed_batches: adaptive.completed.length, last_batch: adaptive.completed.at(-1),
      } } : {}),
      // Never send addresses, result hashes or the child job checkpoint in polls.
      ...(emailRecovery ? { saved_email_review_pending: !!emailRecovery.batch && !emailRecovery.error } : {}),
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
 * Собрать collect_info обратно из точечной проекции VE_BASE_LIST_COLUMNS:
 * PostgREST отдаёт пути плоскими колонками ci_*, а карточка ждёт объект.
 * Форма совпадает с той, что отдавала stripTaskHarvest: те же имена ключей,
 * та же сводка adaptive_collection, тот же флаг saved_email_review_pending.
 * Отличие одно и оно безопасно: JSON null и отсутствие ключа после проекции
 * неразличимы, поэтому null-ключи не попадают в ответ (клиент везде читает
 * collect_info через ?.). stripTaskHarvest остаётся на месте — её по-прежнему
 * зовёт идемпотентный collect POST, который читает полную строку.
 */
export function assembleVeBaseCollectInfo(row: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  const projected = new Map<string, unknown>();
  for (const [column, value] of Object.entries(row)) {
    if (column.startsWith('ci_')) projected.set(column.slice(3), value);
    else base[column] = value;
  }
  const info: Record<string, unknown> = {};
  const put = (key: string, value: unknown) => { if (value !== null && value !== undefined) info[key] = value; };
  for (const key of VE_BASE_COLLECT_INFO_KEYS) put(key, projected.get(key));
  const policyVersion = projected.get('search_policy_version');
  if (policyVersion !== null && policyVersion !== undefined) {
    info.search_policy = { version: policyVersion, phase: projected.get('search_policy_phase') };
  }
  const adaptiveVersion = projected.get('adaptive_version');
  if (adaptiveVersion !== null && adaptiveVersion !== undefined) {
    const raw = projected.get('adaptive_completed');
    const completed = Array.isArray(raw) ? raw : [];
    info.adaptive_collection = {
      version: adaptiveVersion, switches: projected.get('adaptive_switches'),
      note: projected.get('adaptive_note') ?? undefined,
      replan_error: projected.get('adaptive_replan_error') ?? undefined,
      checking_batch: projected.get('adaptive_pending_id') != null,
      completed_batches: completed.length, last_batch: completed.at(-1),
    };
  }
  if (projected.get('saved_email_attempt_id') != null) {
    info.saved_email_review_pending = projected.get('saved_email_batch_id') != null
      && projected.get('saved_email_error') == null;
  }
  const tasks: Record<string, unknown>[] = [];
  for (let slot = 0; slot < VE_BASE_TASK_SLOTS; slot += 1) {
    const task: Record<string, unknown> = {};
    for (const field of VE_BASE_TASK_FIELDS) {
      const value = projected.get(`task_${slot}_${field}`);
      if (value !== null && value !== undefined) task[field] = value;
    }
    if (Object.keys(task).length === 0) break;
    tasks.push(task);
  }
  if (VE_BASE_TASK_FIELDS.some((field) => projected.get(`task_${VE_BASE_TASK_SLOTS}_${field}`) != null)) {
    console.warn(`[ve-detail] base ${String(base.id)}: tasks projection truncated at ${VE_BASE_TASK_SLOTS} slots`);
  }
  if (tasks.length > 0) info.tasks = tasks;
  return { ...base, collect_info: Object.keys(info).length > 0 ? info : null };
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
      .range(from, to)
      // Точечная проекция не типизируется генериком select(): для supabase-js
      // это обычная строка, и строки вырождаются в GenericStringError[].
      // Тот же приём, что в costTelemetry.VE_CHILD_SNAPSHOT_SELECT.
      .overrideTypes<Record<string, unknown>[], { merge: false }>()),
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
      bases: (basesRes.data ?? []).map(assembleVeBaseCollectInfo),
      templates,
      jobs: jobsRes.data ?? [],
      dossiers: dossiersRes.data ?? [],
      cases: casesRes.data ?? [],
    },
  };
}

'use client';

/**
 * Клиентские хелперы и DTO-типы для «Движка вертикалей» (Hypothesis Engine).
 * Кодируется строго под контракт API /api/tools/vertical-engine-v2/*.
 */

import { authFetch } from '@/lib/authFetch';
import type { ClientBriefFields } from '@/lib/clientBrief';
import type {
  VeBase,
  VeChain,
  VeChainLetter,
  VeHypothesis,
  VeJob,
  VeProject,
  VeTemplate,
  VeVertical,
  VeVocab,
} from '@/lib/verticalEngineV2/types';

export const VE_API = '/api/tools/vertical-engine-v2';

/* ── Автосборка базы (POST /verticals/[id]/collect) ── */

/** Источник базы: ручная загрузка файла или автосборка движком. */
export type VeBaseSource = 'upload' | 'auto';

/** Задача из плана автосборки (collect_info.plan.tasks): почему выбран этот источник. */
export interface VeCollectPlanTask {
  source?: string;
  rationale?: string;
}

/** Живая задача автосборки (collect_info.tasks): статус и счётчик собранных строк. */
export interface VeCollectTask {
  source?: string;
  status?: string;
  rows?: number;
}

/**
 * Прогресс автосборки (ve_bases.collect_info, jsonb). Форма толерантная:
 * все поля опциональны, на клиенте читать защитно.
 */
/**
 * Решения автопилота о плане источников — их обязательно показывать: машина
 * может подменить каталожный срез или вовсе отказаться строить базу, и без
 * объяснения это выглядит сбоем. Пишутся в stages/baseCollect.
 */
export interface VePlanRepairDto {
  reason?: 'no_catalog_source';
  outcome?: 'repaired' | 'failed';
  error?: string | null;
}

export interface VeSliceProbeDto {
  outcome?: 'passed' | 'repaired' | 'repair_failed' | 'rejected';
  /** Доля строк выборки, признанных принадлежащими вертикали (0..1). */
  hit_rate?: number;
  sampled?: number;
  first_hit_rate?: number;
  off_target_examples?: string[] | null;
  /** Сколько каталожных задач плана заменено одним срезом (repaired). */
  replaced_tasks?: number;
  error?: string | null;
}

/** Оценка каталога по точным фильтрам одной гипотезы, до лимита конкретного прогона. */
export interface VeCollectEstimateDto {
  /** Уникальные компании по ИНН, подходящие под фильтры гипотезы. */
  unique_companies?: number | null;
  /** Из них matching-компании с email в строке среза (ещё не валидирован). */
  companies_with_email?: number | null;
  companies_with_phone?: number | null;
  directory_rows_total?: number | null;
  /** Почему оценка недоступна, например при нескольких пересекающихся срезах реестра. */
  note?: string | null;
}

/** Воронка одного прогона автосборки: от ответа источников до готовых получателей. */
export interface VeCollectStatsDto {
  tasks_total?: number | null;
  tasks_done?: number | null;
  tasks_failed?: number | null;
  /** Кандидаты после объединения источников и дедупликации, до конструктора. */
  rows_total?: number | null;
  /** Строки, оставшиеся после конструктора и обработки. */
  processed_rows?: number | null;
  /**
   * Уникальные email после полной validation, relevance и dedup. Лимит одного
   * запуска проверяется отдельно и может потребовать разделить аудиторию.
   */
  launchable_rows?: number | null;
  low_relevance?: number | null;
  /** Строки без надёжного relevance-verdict; они fail-closed исключены. */
  relevance_unchecked?: number | null;
  relevance_checked_companies?: number | null;
  relevance_total_companies?: number | null;
  relevance_coverage_complete?: boolean | null;
  excluded_existing_bases?: number | null;
  excluded_during_fetch?: number | null;
  finished_at?: string | null;
}

export interface VeCollectInfo {
  /** Лимит строк, выбранный при запуске сборки (у старых записей поля нет). */
  limit?: number | null;
  /** Гипотезы, выбранные при запуске сборки (у записей до пикера гипотез поля нет). */
  hypothesis_ids?: string[] | null;
  /** Снапшот гипотез, по которым фактически построен план. */
  hypotheses?: Array<{ id?: string; title?: string; status?: string | null }> | null;
  plan?: { tasks?: VeCollectPlanTask[] } | null;
  tasks?: VeCollectTask[] | null;
  estimate?: VeCollectEstimateDto | null;
  stats?: VeCollectStatsDto | null;
  /** Каталог добавлен в план, которого в нём не было. */
  plan_repair?: VePlanRepairDto | null;
  /** Итог пробы каталожного среза на принадлежность вертикали. */
  slice_probe?: VeSliceProbeDto | null;
}

/** GET /projects/[id] отдаёт усечённые строки баз (без тяжёлого data). */
export type VeBaseSummary = Pick<
  VeBase,
  'id' | 'vertical_id' | 'hypothesis_id' | 'filename' | 'row_count' | 'analysis' | 'created_at' | 'columns' | 'sample_rows'
> & {
  /**
   * Причина падения сборки. Обязательна на экране с тех пор, как автопилот
   * умеет осознанно НЕ строить базу (проба среза): один статус 'failed'
   * читается как поломка. Опционально — у старых записей и в фикстурах нет.
   */
  error?: string | null;
  /** Статус разбора + 'collecting' (идёт автосборка; появился вместе с collect-эндпоинтом). */
  status: VeBase['status'] | 'collecting';
  /** Откуда база. У записей, созданных до автосборки, поля нет — считать 'upload'. */
  source?: VeBaseSource;
  /** План/прогресс автосборки (null у загруженных вручную). */
  collect_info?: VeCollectInfo | null;
};

/** Усечённая строка джобы (без result/tokens). */
export type VeJobSummary = Pick<
  VeJob,
  'id' | 'stage' | 'status' | 'error' | 'attempts' | 'started_at'
> & {
  finished_at: string | null;
  /** Вход стадии: фильтрация джоб по вертикали (payload.vertical_id). */
  payload?: { vertical_id?: string } | null;
  /** Живой прогресс стадии (ve_jobs.progress): счётчик «— 14/33 · проверяем гипотезу». */
  progress?: { done?: number; total?: number; label?: string } | null;
};

/* ── Цепочка писем: A/B-варианты ── */

/** A/B-вариант письма: альтернативные тема/тело рядом с основным (= «вариант A»). */
export interface VeLetterVariant {
  subject: string | null;
  body: string;
}

/**
 * Письмо цепочки по контракту API. Отличается от VeChainLetter в lib-типах:
 * variants — массив объектов {subject, body} (легаси-строки UI отбрасывает).
 */
export type VeChainLetterDto = Omit<VeChainLetter, 'variants'> & {
  variants?: VeLetterVariant[];
};

/** Цепочка из выдачи API: letters — VeChainLetterDto. */
export type VeChainDto = Omit<VeChain, 'letters'> & { letters: VeChainLetterDto[] };

/** PATCH /chains/[id] { letter_index, variant_index } → { letters }. */
export interface VeChainPatchResponse {
  letters?: VeChainLetterDto[];
  error?: string;
}

/* ── Досье вертикали ── */

/** Сигнал боли из счётчиков досье (jsonb). */
export interface VeDossierSignal {
  kind: string;
  label: string;
  value: string | number;
  source?: string;
}

/** Форма jsonb-поля data досье вертикали — объективные числа сегмента. */
export interface VeDossierData {
  counters: {
    /** Legacy-алиас: в старых досье мог означать строки справочника, а не уникальные компании. */
    companies_total: number | null;
    /** Сырые строки справочника до дедупликации по ИНН. */
    directory_rows_total?: number | null;
    /** Уникальные компании по ИНН в широком срезе вертикали. */
    companies_unique_total?: number | null;
    /** Наличие канала в справочнике не означает, что адрес/телефон уже проверен. */
    companies_with_email?: number | null;
    companies_with_phone?: number | null;
    companies_with_any_contact?: number | null;
    companies_note?: string;
    hh_vacancies_total: number | null;
    hh_vacancies_sample: string[];
    signals: VeDossierSignal[];
  };
  dataset_stats: {
    matched_segments: string[];
    campaigns: number;
    sent: number;
    replies: number;
    reply_pct: number | null;
    baseline_pct: number | null;
    top_subjects: string[];
    note?: string;
  };
  interpretation: {
    market_summary: string;
    pain_signals: string[];
    segment_size_assessment: string;
    dataset_verdict: string;
    /** Вердикт «сегмент покупает каналы продаж»; у досье, собранных до его появления, поля нет. */
    buys_sales_channels?: 'yes' | 'likely' | 'unknown';
    buys_sales_channels_reason?: string;
  };
  computed_at: string;
}

export type VeDossierStatus = 'draft' | 'ready' | 'failed';

/** Строка досье вертикали в выдаче GET /projects/[id]. */
export interface VeDossier {
  id: string;
  vertical_id: string;
  status: VeDossierStatus;
  data: VeDossierData | null;
  error: string | null;
}

/* ── Банк кейсов клиента ── */

/** Кейс клиента (с сайта или загруженный вручную) в выдаче GET /projects/[id]. */
export interface VeCaseEntry {
  id: string;
  source: 'site' | 'upload';
  filename: string | null;
  industry: string | null;
  client_type: string | null;
  task: string | null;
  /** Структурированные метрики результата (ve_cases.metrics — jsonb). */
  metrics: Record<string, unknown> | null;
  result: string | null;
  created_at: string;
}

export interface VeProjectsResponse {
  projects?: VeProject[];
  error?: string;
}

export interface VeLegacyDuplicateDto {
  id: string;
  name: string;
  website_url: string;
}

export interface VeProjectCreateConflictDto {
  domain?: string;
  legacy_projects?: VeLegacyDuplicateDto[];
}

export interface VeProjectCreateResponse {
  project?: VeProject;
  error?: string;
  code?: string;
  conflict?: VeProjectCreateConflictDto;
}

export interface VeProjectResponse {
  project?: VeProject;
  error?: string;
}

export interface VeProjectDetailResponse {
  project?: VeProject;
  hypotheses?: VeHypothesis[];
  verticals?: VeVertical[];
  chains?: VeChainDto[];
  vocabs?: VeVocab[];
  bases?: VeBaseSummary[];
  templates?: VeTemplate[];
  jobs?: VeJobSummary[];
  dossiers?: VeDossier[];
  cases?: VeCaseEntry[];
  error?: string;
}

export interface VeJobResponse {
  ok?: boolean;
  job?: VeJobSummary;
  error?: string;
}

export interface VeHypothesisResponse {
  hypothesis?: VeHypothesis;
  /** Пересчитанные после разметки вертикали проекта (id + новые pct/rank). */
  verticals?: Array<{ id: string; potential_pct: number; rank: number }> | null;
  error?: string;
}

export interface VeBaseCreateResponse {
  base?: { id: string; status: string };
  error?: string;
}

/**
 * POST /verticals/[id]/collect → 201 { ok, base } — сборка стартовала;
 * 200 { ok, existing: true, base } — уже собирается (дедуп), base несёт
 * collect_info, чтобы UI показал лимит идущей сборки.
 */
export interface VeBaseCollectResponse {
  ok?: boolean;
  /** true на дедуп-ответах (200): повторный запуск не создан, идёт чужая сборка. */
  existing?: boolean;
  base?: { id: string; status: string; collect_info?: VeCollectInfo | null };
  error?: string;
}

/** POST /projects/[id]/cases → 201 { case }. */
export interface VeCaseCreateResponse {
  case?: VeCaseEntry;
  error?: string;
}

/** DELETE /projects/[id]/cases { id } → { ok }. */
export interface VeCaseDeleteResponse {
  ok?: boolean;
  error?: string;
}

/** Рамка ЦА из брифа: ограничение генерации гипотез. */
export interface VeClientBriefIcpDto {
  include: string[];
  exclude: string[];
  size: string;
  geo: string;
  triggers: string[];
  qualification: string;
}

/** Бриф клиента проекта (ve_projects.brief.client_brief). */
export interface VeClientBriefDto {
  fields: ClientBriefFields;
  /** Поля, которых у клиента нет: промпты о них знают и не выдумывают. */
  missing: string[];
  /** null — клиент рамку ЦА не задал. */
  icp: VeClientBriefIcpDto | null;
  /** Типы действующих клиентов без имён — в письма идут они. */
  client_types: string[];
  file_name: string | null;
  uploaded_at: string;
}

/** GET/POST/PUT /projects/[id]/brief. */
export interface VeClientBriefResponse {
  ok?: boolean;
  brief?: VeClientBriefDto | null;
  compiled_brief_text?: string;
  error?: string;
}

/** authFetch + безопасный json-parse, без throw — вызывающий смотрит на ok/status. */
export async function veEngineCall<T>(
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await authFetch(url, init);
  const data = (await res.json().catch(() => ({}))) as T;
  return { ok: res.ok, status: res.status, data };
}

export function veEnginePost<T>(url: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T }> {
  return veEngineCall<T>(url, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function veEnginePatch<T>(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: T }> {
  return veEngineCall<T>(url, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export function veEngineDelete<T>(url: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T }> {
  return veEngineCall<T>(url, {
    method: 'DELETE',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Состояние отслеживаемой джобы (по id, возвращённому POST-эндпоинтом). */
export type WatchedJobState = 'idle' | 'active' | 'done' | 'failed';

export function watchedJobState(jobs: VeJobSummary[], jobId: string | undefined): WatchedJobState {
  if (!jobId) return 'idle';
  const job = jobs.find((j) => j.id === jobId);
  // Джобы ещё нет в выдаче (только что создали, не успели запollить) — считаем активной.
  if (!job) return 'active';
  if (job.status === 'pending' || job.status === 'running') return 'active';
  // cancelled схлопываем в failed: наблюдающая кнопка гаснет, успех не рисуем.
  return job.status === 'failed' || job.status === 'cancelled' ? 'failed' : 'done';
}

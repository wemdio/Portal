'use client';

/**
 * Клиентские хелперы и DTO-типы для «Движка вертикалей» (Hypothesis Engine).
 * Кодируется строго под контракт API /api/tools/hypothesis-engine/*.
 */

import { authFetch } from '@/lib/authFetch';
import type {
  HeBase,
  HeChain,
  HeChainLetter,
  HeHypothesis,
  HeJob,
  HeProject,
  HeTemplate,
  HeVertical,
  HeVocab,
} from '@/lib/hypothesisEngine/types';

export const HE_API = '/api/tools/hypothesis-engine';

/** GET /projects/[id] отдаёт усечённые строки баз (без data/sample_rows). */
export type HeBaseSummary = Pick<
  HeBase,
  'id' | 'vertical_id' | 'filename' | 'row_count' | 'status' | 'analysis' | 'created_at'
>;

/** Усечённая строка джобы (без result/tokens). */
export type HeJobSummary = Pick<
  HeJob,
  'id' | 'stage' | 'status' | 'error' | 'attempts' | 'started_at'
> & {
  finished_at: string | null;
  /** Вход стадии: фильтрация джоб по вертикали (payload.vertical_id). */
  payload?: { vertical_id?: string } | null;
  /** Живой прогресс стадии (he_jobs.progress): счётчик «— 14/33 · проверяем гипотезу». */
  progress?: { done?: number; total?: number; label?: string } | null;
};

/* ── Цепочка писем: A/B-варианты ── */

/** A/B-вариант письма: альтернативные тема/тело рядом с основным (= «вариант A»). */
export interface HeLetterVariant {
  subject: string | null;
  body: string;
}

/**
 * Письмо цепочки по контракту API. Отличается от HeChainLetter в lib-типах:
 * variants — массив объектов {subject, body} (легаси-строки UI отбрасывает).
 */
export type HeChainLetterDto = Omit<HeChainLetter, 'variants'> & {
  variants?: HeLetterVariant[];
};

/** Цепочка из выдачи API: letters — HeChainLetterDto. */
export type HeChainDto = Omit<HeChain, 'letters'> & { letters: HeChainLetterDto[] };

/** PATCH /chains/[id] { letter_index, variant_index } → { letters }. */
export interface HeChainPatchResponse {
  letters?: HeChainLetterDto[];
  error?: string;
}

/* ── Досье вертикали ── */

/** Сигнал боли из счётчиков досье (jsonb). */
export interface HeDossierSignal {
  kind: string;
  label: string;
  value: string | number;
  source?: string;
}

/** Форма jsonb-поля data досье вертикали — объективные числа сегмента. */
export interface HeDossierData {
  counters: {
    companies_total: number | null;
    companies_note?: string;
    hh_vacancies_total: number | null;
    hh_vacancies_sample: string[];
    signals: HeDossierSignal[];
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

export type HeDossierStatus = 'draft' | 'ready' | 'failed';

/** Строка досье вертикали в выдаче GET /projects/[id]. */
export interface HeDossier {
  id: string;
  vertical_id: string;
  status: HeDossierStatus;
  data: HeDossierData | null;
  error: string | null;
}

/* ── Банк кейсов клиента ── */

/** Кейс клиента (с сайта или загруженный вручную) в выдаче GET /projects/[id]. */
export interface HeCaseEntry {
  id: string;
  source: 'site' | 'upload';
  filename: string | null;
  industry: string | null;
  client_type: string | null;
  task: string | null;
  /** Структурированные метрики результата (he_cases.metrics — jsonb). */
  metrics: Record<string, unknown> | null;
  result: string | null;
  created_at: string;
}

export interface HeProjectsResponse {
  projects?: HeProject[];
  error?: string;
}

export interface HeProjectCreateResponse {
  project?: HeProject;
  error?: string;
}

export interface HeProjectResponse {
  project?: HeProject;
  error?: string;
}

export interface HeProjectDetailResponse {
  project?: HeProject;
  hypotheses?: HeHypothesis[];
  verticals?: HeVertical[];
  chains?: HeChainDto[];
  vocabs?: HeVocab[];
  bases?: HeBaseSummary[];
  templates?: HeTemplate[];
  jobs?: HeJobSummary[];
  dossiers?: HeDossier[];
  cases?: HeCaseEntry[];
  error?: string;
}

export interface HeJobResponse {
  ok?: boolean;
  job?: HeJobSummary;
  error?: string;
}

export interface HeHypothesisResponse {
  hypothesis?: HeHypothesis;
  /** Пересчитанные после разметки вертикали проекта (id + новые pct/rank). */
  verticals?: Array<{ id: string; potential_pct: number; rank: number }> | null;
  error?: string;
}

export interface HeBaseCreateResponse {
  base?: { id: string; status: string };
  error?: string;
}

/** POST /projects/[id]/cases → 201 { case }. */
export interface HeCaseCreateResponse {
  case?: HeCaseEntry;
  error?: string;
}

/** DELETE /projects/[id]/cases { id } → { ok }. */
export interface HeCaseDeleteResponse {
  ok?: boolean;
  error?: string;
}

/** authFetch + безопасный json-parse, без throw — вызывающий смотрит на ok/status. */
export async function heCall<T>(
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await authFetch(url, init);
  const data = (await res.json().catch(() => ({}))) as T;
  return { ok: res.ok, status: res.status, data };
}

export function hePost<T>(url: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T }> {
  return heCall<T>(url, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function hePatch<T>(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: T }> {
  return heCall<T>(url, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export function heDelete<T>(url: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T }> {
  return heCall<T>(url, {
    method: 'DELETE',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Состояние отслеживаемой джобы (по id, возвращённому POST-эндпоинтом). */
export type WatchedJobState = 'idle' | 'active' | 'done' | 'failed';

export function watchedJobState(jobs: HeJobSummary[], jobId: string | undefined): WatchedJobState {
  if (!jobId) return 'idle';
  const job = jobs.find((j) => j.id === jobId);
  // Джобы ещё нет в выдаче (только что создали, не успели запollить) — считаем активной.
  if (!job) return 'active';
  if (job.status === 'pending' || job.status === 'running') return 'active';
  return job.status === 'failed' ? 'failed' : 'done';
}

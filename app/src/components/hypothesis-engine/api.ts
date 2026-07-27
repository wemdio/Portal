'use client';

/**
 * Клиентские хелперы и DTO-типы для «Движка вертикалей» (Hypothesis Engine).
 * Кодируется строго под контракт API /api/tools/hypothesis-engine/*.
 */

import { authFetch } from '@/lib/authFetch';
import type {
  HeBase,
  HeChain,
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

/** Усечённая строка джобы (без payload/result/tokens). */
export type HeJobSummary = Pick<
  HeJob,
  'id' | 'stage' | 'status' | 'error' | 'attempts' | 'started_at'
> & { finished_at: string | null };

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
  chains?: HeChain[];
  vocabs?: HeVocab[];
  bases?: HeBaseSummary[];
  templates?: HeTemplate[];
  jobs?: HeJobSummary[];
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

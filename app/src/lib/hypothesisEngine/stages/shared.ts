/**
 * Общие хелперы стадий «Движка вертикалей»: контракт контекста/результата,
 * аккумулятор токенов, чтение проекта и результатов предыдущих стадий.
 *
 * HeStageContext/HeStageResult объявлены здесь (а не в index.ts), чтобы
 * модули стадий не импортировали индексный диспетчер (циклический импорт).
 * stages/index.ts реэкспортирует оба интерфейса — внешний контракт не меняется.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { HeJob, HeProject, HeStage } from '../types';

export interface HeStageContext {
  supabase: SupabaseClient; /* supabaseAdmin client — создаётся воркером и передаётся сюда */
  /** Подменяемый фетч текста страницы (дефолт — SSRF-гейт + websiteParser, см. io.ts). */
  fetchText?: (url: string) => Promise<string>;
  /** Подменяемый поиск (дефолт — serperSearch, best-effort: может вернуть []). */
  search?: (q: string) => Promise<Array<{ title: string; link: string; snippet?: string }>>;
  log?: (msg: string) => void;
}

export interface HeStageResult {
  result: unknown;
  tokensUsed?: number;
  costUsd?: number;
}

/** Аккумулятор расхода за стадию (все LLM-вызовы суммируются). */
export interface HeUsage {
  tokensUsed: number;
  costUsd: number;
}

export function newUsage(): HeUsage {
  return { tokensUsed: 0, costUsd: 0 };
}

export function addUsage(acc: HeUsage, llm: { tokensUsed: number; costUsd: number }): void {
  acc.tokensUsed += llm.tokensUsed;
  acc.costUsd += llm.costUsd;
}

export function stageLog(ctx: HeStageContext, msg: string): void {
  ctx.log?.(msg);
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + '…';
}

/** Прочитать проект или упасть с понятной ошибкой (стадия → job failed). */
export async function readProject(supabase: SupabaseClient, projectId: string): Promise<HeProject> {
  const { data, error } = await supabase
    .from('he_projects')
    .select('*')
    .eq('id', projectId)
    .single();
  if (error || !data) {
    throw new Error(`he_projects ${projectId}: ${error?.message ?? 'not found'}`);
  }
  return data as HeProject;
}

/**
 * Результат последней успешной стадии заданного типа (для цепочки
 * research-стадий: competitors → brand_cloud → hypotheses → evidence).
 */
export async function latestDoneJobResult<T = Record<string, unknown>>(
  supabase: SupabaseClient,
  projectId: string,
  stage: HeStage,
): Promise<T | null> {
  const { data, error } = await supabase
    .from('he_jobs')
    .select('result')
    .eq('project_id', projectId)
    .eq('stage', stage)
    .eq('status', 'done')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`he_jobs read (${stage}): ${error.message}`);
  }
  return (data?.result as T | undefined) ?? null;
}

/** site_profile лежит в he_projects.brief.site_profile — достать или упасть. */
export function readSiteProfile<T = Record<string, unknown>>(project: HeProject): T {
  const profile = (project.brief as Record<string, unknown> | null)?.site_profile;
  if (!profile || typeof profile !== 'object') {
    throw new Error('he_projects.brief.site_profile отсутствует — сначала выполните стадию site_profile');
  }
  return profile as T;
}

/** Достать обязательный string-параметр из payload джобы. */
export function payloadString(job: HeJob, key: string): string {
  const value = job.payload?.[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`job.payload.${key} обязателен для стадии ${job.stage}`);
  }
  return value.trim();
}

/**
 * Общие хелперы стадий «Движка вертикалей»: контракт контекста/результата,
 * аккумулятор токенов, чтение проекта и результатов предыдущих стадий.
 *
 * VeStageContext/VeStageResult объявлены здесь (а не в index.ts), чтобы
 * модули стадий не импортировали индексный диспетчер (циклический импорт).
 * stages/index.ts реэкспортирует оба интерфейса — внешний контракт не меняется.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { VeMarket } from '../market';
import type { VeJob, VeProject, VeStage } from '../types';

export interface VeStageContext {
  supabase: SupabaseClient; /* supabaseAdmin client — создаётся воркером и передаётся сюда */
  /** Подменяемый фетч текста страницы (дефолт — SSRF-гейт + websiteParser, см. io.ts). */
  fetchText?: (url: string) => Promise<string>;
  /** Подменяемый поиск (дефолт — serperSearch, best-effort: может вернуть []). */
  search?: (q: string) => Promise<Array<{ title: string; link: string; snippet?: string }>>;
  /** Рынок проекта (воркер читает ve_projects.market): geo Serper, язык промптов. */
  market?: VeMarket;
  log?: (msg: string) => void;
}

export interface VeStageResult {
  result: unknown;
  tokensUsed?: number;
  costUsd?: number;
}

/** Аккумулятор расхода за стадию (все LLM-вызовы суммируются). */
export interface VeUsage {
  tokensUsed: number;
  costUsd: number;
}

export function newUsage(): VeUsage {
  return { tokensUsed: 0, costUsd: 0 };
}

export function addUsage(acc: VeUsage, llm: { tokensUsed: number; costUsd: number }): void {
  acc.tokensUsed += llm.tokensUsed;
  acc.costUsd += llm.costUsd;
}

export function stageLog(ctx: VeStageContext, msg: string): void {
  ctx.log?.(msg);
}

/** Worker preserves this pending state after a waiting stage returns. */
export async function requeueVeJob(ctx: VeStageContext, job: VeJob, cooldownMs = 30_000): Promise<void> {
  const { error } = await ctx.supabase.from('ve_jobs').update({
    status: 'pending',
    started_at: null,
    run_after: new Date(Date.now() + cooldownMs).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', job.id).eq('status', 'running');
  if (error) throw new Error(`ve_jobs requeue: ${error.message}`);
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + '…';
}

/** Прочитать проект или упасть с понятной ошибкой (стадия → job failed). */
export async function readProject(supabase: SupabaseClient, projectId: string): Promise<VeProject> {
  const { data, error } = await supabase
    .from('ve_projects')
    .select('*')
    .eq('id', projectId)
    .single();
  if (error || !data) {
    throw new Error(`ve_projects ${projectId}: ${error?.message ?? 'not found'}`);
  }
  return data as VeProject;
}

/**
 * Результат последней успешной стадии заданного типа (для цепочки
 * research-стадий: competitors → brand_cloud → hypotheses → evidence).
 */
export async function latestDoneJobResult<T = Record<string, unknown>>(
  supabase: SupabaseClient,
  projectId: string,
  stage: VeStage,
): Promise<T | null> {
  const { data, error } = await supabase
    .from('ve_jobs')
    .select('result')
    .eq('project_id', projectId)
    .eq('stage', stage)
    .eq('status', 'done')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`ve_jobs read (${stage}): ${error.message}`);
  }
  return (data?.result as T | undefined) ?? null;
}

/** site_profile лежит в ve_projects.brief.site_profile — достать или упасть. */
export function readSiteProfile<T = Record<string, unknown>>(project: VeProject): T {
  const profile = (project.brief as Record<string, unknown> | null)?.site_profile;
  if (!profile || typeof profile !== 'object') {
    throw new Error('ve_projects.brief.site_profile отсутствует — сначала выполните стадию site_profile');
  }
  return profile as T;
}

/** Достать обязательный string-параметр из payload джобы. */
export function payloadString(job: VeJob, key: string): string {
  const value = job.payload?.[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`job.payload.${key} обязателен для стадии ${job.stage}`);
  }
  return value.trim();
}

/**
 * Общие хелперы стадий «Движка вертикалей»: контракт контекста/результата,
 * аккумулятор токенов, чтение проекта и результатов предыдущих стадий.
 *
 * VeStageContext/VeStageResult объявлены здесь (а не в index.ts), чтобы
 * модули стадий не импортировали индексный диспетчер (циклический импорт).
 * stages/index.ts реэкспортирует оба интерфейса — внешний контракт не меняется.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { isTransientDbError } from '@/lib/db/transientError';
import { VeJobQueuePersistenceError } from '../jobFailureTransition';

import type { VeMarket } from '../market';
import type { VeJob, VeProject, VeStage } from '../types';

export interface VeStageContext {
  supabase: SupabaseClient; /* supabaseAdmin client — создаётся воркером и передаётся сюда */
  /** Exact invocation owning any paid/parser child; supplied by collection. */
  parentJob?: Pick<VeJob, 'id' | 'started_at'>;
  /** Captured per-job cancellation; never reuse a later job's signal. */
  signal?: AbortSignal;
  /** A durable write has finished; the worker may yield for deployment here. */
  onCheckpoint?: () => void;
  /** Real operation completion, not timer/heartbeat activity. */
  onActivity?: () => void;
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
  const stamp = new Date().toISOString();
  const patch = {
    status: 'pending',
    started_at: null,
    run_after: new Date(Date.now() + cooldownMs).toISOString(),
    updated_at: stamp,
  };
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    ctx.signal?.throwIfAborted();
    let failure: unknown;
    const writeSignal = AbortSignal.timeout(10_000);
    try {
      let write = ctx.supabase.from('ve_jobs').update(patch).eq('id', job.id).eq('status', 'running');
      write = job.started_at == null ? write.is('started_at', null) : write.eq('started_at', job.started_at);
      const { data, error, status } = await write.select('id').abortSignal(writeSignal).maybeSingle();
      ctx.signal?.throwIfAborted();
      if (data && !error) return;
      failure = error;
      if (error && !writeSignal.aborted && !isTransientDbError(error, status) && !/VE_JOB_LEASE_LOST/.test(error.message)) {
        throw new Error(`ve_jobs requeue: ${error.message}`);
      }
    } catch (error) {
      ctx.signal?.throwIfAborted();
      if (!writeSignal.aborted && !isTransientDbError(error) && !/VE_JOB_LEASE_LOST/.test(error instanceof Error ? error.message : '')) throw error;
      failure = error;
    }
    ctx.signal?.throwIfAborted();
    // A gateway can lose the response after COMMIT. Confirm before another
    // write; the stage-write trigger correctly rejects the now-released claim.
    const readSignal = AbortSignal.timeout(10_000);
    try {
      const { data: current, error, status } = await ctx.supabase.from('ve_jobs')
        .select('status,started_at,run_after,updated_at').eq('id', job.id)
        .abortSignal(readSignal).maybeSingle();
      ctx.signal?.throwIfAborted();
      if (error) {
        if (!readSignal.aborted && !isTransientDbError(error, status)) throw new Error(`ve_jobs requeue confirmation: ${error.message}`);
        failure = error;
      }
      else {
        if (current?.status === 'pending' && current.started_at == null
          && Date.parse(current.run_after) === Date.parse(patch.run_after)
          && Date.parse(current.updated_at) === Date.parse(stamp)) return;
        // Cancellation, pause and a new owner always win. Do not restore a
        // stale pending transition or turn a completed job into a failure.
        if (!current || current.status !== 'running'
          || (current.started_at !== job.started_at
            && Date.parse(current.started_at ?? '') !== Date.parse(job.started_at ?? ''))) return;
      }
    } catch (error) {
      ctx.signal?.throwIfAborted();
      if (!readSignal.aborted && !isTransientDbError(error)) throw error;
      failure = error;
    }
    lastError = failure ?? new Error('queue transition was not confirmed');
    if (attempt < 5) await new Promise<void>((resolve, reject) => {
      const done = () => { ctx.signal?.removeEventListener('abort', aborted); resolve(); };
      const timer = setTimeout(done, Math.min(1_000 * 2 ** attempt, 10_000));
      const aborted = () => { clearTimeout(timer); ctx.signal?.removeEventListener('abort', aborted); reject(ctx.signal?.reason); };
      ctx.signal?.addEventListener('abort', aborted, { once: true });
      if (ctx.signal?.aborted) aborted();
    });
  }
  // Bounded retries keep the same invocation/paid result. A prolonged outage
  // then uses the worker's bounded interruption allowance, not provider retries.
  throw new VeJobQueuePersistenceError(lastError instanceof Error ? lastError
    : new Error((lastError as { message?: string } | null)?.message ?? 'queue transition was not confirmed'));
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

import 'server-only';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { withProviderUsage, ProviderUsageWriteError, type ProviderUsageEvent, type ProviderUsageScope } from '@/lib/providerUsage';
import type { VeJob } from './types';

export const VE_USAGE_SOURCE = 've_provider_usage';
export const VE_USAGE_VERSION = 1;

// These projections deliberately exclude harvested rows, queries and contacts.
export const VE_CHILD_SNAPSHOT_SELECT = [
  'round:collect_info->target_progress->>round',
  'construct_id:collect_info->construct->>bc_job_id',
  'collect_started:collect_info->>started_at',
  ...Array.from({ length: 5 }, (_, i) => [
    `source${i}:collect_info->tasks->${i}->>source`,
    `child${i}:collect_info->tasks->${i}->>child_job_id`,
  ]).flat(),
].join(',');

export interface VeChildSnapshot {
  state: 'ok' | 'unavailable';
  round?: number;
  priorProgress?: boolean;
  sources: { source: string; jobId?: string }[];
  constructorJob?: { jobId: string; steps: string[] | null };
  truncated?: boolean;
}

const identifier = (value: unknown) => typeof value === 'string' && /^[\w-]{1,100}$/.test(value) ? value : undefined;

async function childSnapshot(db: SupabaseClient, baseId?: string): Promise<VeChildSnapshot> {
  if (!baseId) return { state: 'ok', sources: [] };
  try {
    const { data, error } = await db.from('ve_bases').select(VE_CHILD_SNAPSHOT_SELECT)
      .eq('id', baseId).abortSignal(AbortSignal.timeout(10_000)).maybeSingle();
    if (error || !data) return { state: 'unavailable', sources: [] };
    const row = data as unknown as Record<string, unknown>;
    const sources = Array.from({ length: 4 }, (_, i) => ({ source: identifier(row[`source${i}`]), jobId: identifier(row[`child${i}`]) }))
      .filter((entry): entry is { source: string; jobId: string | undefined } => Boolean(entry.source));
    const round = row.round == null ? undefined : Number(row.round);
    const snapshot: VeChildSnapshot = {
      state: 'ok', sources, priorProgress: Boolean(row.collect_started || sources.length || row.construct_id),
      ...(Number.isFinite(round) ? { round } : {}),
      ...(row.source4 || row.child4 ? { truncated: true } : {}),
    };
    const constructorId = identifier(row.construct_id);
    if (constructorId) {
      const { data: constructor, error: constructorError } = await db.from('base_constructor_jobs')
        .select('selected_steps').eq('id', constructorId).abortSignal(AbortSignal.timeout(10_000)).maybeSingle();
      const raw = constructor?.selected_steps;
      const steps = !constructorError && Array.isArray(raw) && raw.length <= 30 && raw.every((step) => identifier(step))
        ? raw as string[] : null;
      snapshot.constructorJob = { jobId: constructorId, steps };
    }
    return snapshot;
  } catch {
    return { state: 'unavailable', sources: [] };
  }
}

async function append(db: SupabaseClient, scope: ProviderUsageScope, event: string, context: Record<string, unknown>) {
  try {
    const { error } = await db.from('application_logs').insert({
      level: 'info', source: VE_USAGE_SOURCE, event, message: `VE2 provider accounting: ${event}`,
      request_id: scope.projectId, context: { version: VE_USAGE_VERSION, ...scope, ...context },
    }).abortSignal(AbortSignal.timeout(10_000));
    if (error) throw new ProviderUsageWriteError();
  } catch {
    throw new ProviderUsageWriteError();
  }
}

function eventFields(event: ProviderUsageEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of [
    'attemptId', 'provider', 'phase', 'status', 'requestedModel', 'actualModel', 'providerRequestId',
    'httpStatus', 'promptTokens', 'completionTokens', 'cachedTokens', 'reportedCostUsd', 'estimatedCostUsd', 'serperCredits',
  ] as const) if (event[key] !== undefined) out[key] = event[key];
  return out;
}

/** A self-requeue is a finished invocation, even though its ve_jobs row remains pending. */
export async function withVeCostTelemetry<T>(db: SupabaseClient, job: VeJob, work: () => Promise<T>): Promise<T> {
  const scope: ProviderUsageScope = {
    projectId: job.project_id, jobId: job.id, stage: job.stage,
    ...(identifier(job.payload.base_id) ? { baseId: String(job.payload.base_id) } : {}),
  };
  const runId = randomUUID();
  let origin = job.payload.provider_usage_origin as { runId?: unknown } | undefined;
  if (origin === undefined || origin === null) {
    const payload = { ...job.payload, provider_usage_origin: { runId, startedAt: new Date().toISOString() } };
    try {
      const { data, error } = await db.from('ve_jobs').update({ payload })
        .eq('id', job.id).eq('status', 'running').is('payload->provider_usage_origin', null)
        .select('id').abortSignal(AbortSignal.timeout(10_000)).maybeSingle();
      if (error || !data) throw new ProviderUsageWriteError();
      job.payload = payload;
      origin = payload.provider_usage_origin;
    } catch { throw new ProviderUsageWriteError(); }
  }
  if (!identifier(origin?.runId)) throw new ProviderUsageWriteError();
  const startChildren = job.stage === 'base_collect' ? await childSnapshot(db, scope.baseId) : undefined;
  await append(db, scope, 'stage_started', {
    runId, originRunId: origin.runId, priorTokensUsed: job.tokens_used, priorEstimatedCostUsd: job.cost_usd,
    priorCheckpoint: Boolean(job.result && Object.keys(job.result).length),
    ...(startChildren ? { children: startChildren } : {}),
  });
  let outcome: 'returned' | 'threw' = 'threw';
  try {
    const result = await withProviderUsage(scope,
      (currentScope, event) => append(db, currentScope, event.phase, { runId, ...eventFields(event) }), work);
    outcome = 'returned';
    return result;
  } finally {
    const children = job.stage === 'base_collect' ? await childSnapshot(db, scope.baseId) : undefined;
    // A missing finish marker remains an explicit accounting gap after process death or failed persistence.
    await append(db, scope, 'stage_finished', { runId, outcome, ...(children ? { children } : {}) });
  }
}

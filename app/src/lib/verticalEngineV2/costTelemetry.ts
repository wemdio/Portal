import 'server-only';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { withProviderUsage, ProviderUsageWriteError, type ProviderUsageEvent, type ProviderUsageScope } from '@/lib/providerUsage';
import { getVeActiveJobSignal } from './llm';
import type { VeJob } from './types';

export const VE_USAGE_SOURCE = 've_provider_usage';
export const VE_USAGE_VERSION = 1;

// These projections deliberately exclude harvested rows, queries and contacts.
export const VE_CHILD_SNAPSHOT_SELECT = [
  'round:collect_info->target_progress->>round',
  'construct_id:collect_info->construct->>bc_job_id',
  'preview_jobs:collect_info->preview_pipeline->job_ids',
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
  constructorJobs?: Array<{ jobId: string; steps: string[] | null }>;
  truncated?: boolean;
}

const identifier = (value: unknown) => typeof value === 'string' && /^[\w-]{1,100}$/.test(value) ? value : undefined;

// 2ГИС: близнецы two_gis стоят рядом со своими Яндекс-задачами и не дочерние джобы. Если среди
// первых пяти задач есть близнец, хвост 5..16 читается отдельно, а в первые 4 источника идут
// настоящие задачи; базы без близнецов читаются как раньше.
const taskPaths = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => from + k)
  .flatMap((i) => [`source${i}:collect_info->tasks->${i}->>source`, `child${i}:collect_info->tasks->${i}->>child_job_id`]);
const VE_TWIN_TAIL_SELECT = taskPaths(5, 16).join(',');

type VeSnapshotSource = { source: string; jobId: string | undefined };
const snapshotEntry = (row: Record<string, unknown>, i: number) => ({ source: identifier(row[`source${i}`]), jobId: identifier(row[`child${i}`]) });

async function twinTail(db: SupabaseClient, baseId: string, row: Record<string, unknown>):
  Promise<{ sources: VeSnapshotSource[]; truncated: boolean } | null> {
  const { data, error } = await db.from('ve_bases').select(VE_TWIN_TAIL_SELECT)
    .eq('id', baseId).abortSignal(AbortSignal.timeout(10_000)).maybeSingle();
  if (error || !data) return null;
  const tail = data as unknown as Record<string, unknown>;
  const all = [...Array.from({ length: 5 }, (_, i) => snapshotEntry(row, i)), ...Array.from({ length: 11 }, (_, k) => snapshotEntry(tail, 5 + k))]
    .filter((entry): entry is VeSnapshotSource => Boolean(entry.source));
  const real = all.filter((entry) => entry.source !== 'two_gis');
  return { sources: [...real.slice(0, 4), ...all.filter((entry) => entry.source === 'two_gis')],
    truncated: real.length > 4 || Boolean(tail.source16 || tail.child16) };
}

async function childSnapshot(db: SupabaseClient, baseId?: string): Promise<VeChildSnapshot> {
  if (!baseId) return { state: 'ok', sources: [] };
  try {
    const { data, error } = await db.from('ve_bases').select(VE_CHILD_SNAPSHOT_SELECT)
      .eq('id', baseId).abortSignal(AbortSignal.timeout(10_000)).maybeSingle();
    if (error || !data) return { state: 'unavailable', sources: [] };
    const row = data as unknown as Record<string, unknown>;
    const twins = (row.source4 || row.child4) && Array.from({ length: 5 }, (_, i) => row[`source${i}`]).includes('two_gis')
      ? await twinTail(db, baseId, row) : undefined;
    if (twins === null) return { state: 'unavailable', sources: [] };
    const sources = twins?.sources ?? Array.from({ length: 4 }, (_, i) => ({ source: identifier(row[`source${i}`]), jobId: identifier(row[`child${i}`]) }))
      .filter((entry): entry is { source: string; jobId: string | undefined } => Boolean(entry.source));
    const round = row.round == null ? undefined : Number(row.round);
    const snapshot: VeChildSnapshot = {
      state: 'ok', sources, priorProgress: Boolean(row.collect_started || sources.length || row.construct_id),
      ...(Number.isFinite(round) ? { round } : {}),
      ...((twins ? twins.truncated : row.source4 || row.child4) ? { truncated: true } : {}),
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
    if (Array.isArray(row.preview_jobs) && row.preview_jobs.length > 0) {
      const ids = [...new Set(row.preview_jobs.map(identifier).filter((id): id is string => !!id))].slice(0, 100);
      if (ids.length !== row.preview_jobs.length) snapshot.truncated = true;
      const { data: jobs, error: jobsError } = await db.from('base_constructor_jobs')
        .select('id, selected_steps').in('id', ids).abortSignal(AbortSignal.timeout(10_000));
      snapshot.constructorJobs = ids.map((jobId) => {
        const raw = jobs?.find((job) => job.id === jobId)?.selected_steps;
        return { jobId, steps: !jobsError && Array.isArray(raw) && raw.length <= 30 && raw.every((step) => identifier(step)) ? raw as string[] : null };
      });
    }
    return snapshot;
  } catch {
    return { state: 'unavailable', sources: [] };
  }
}

async function append(db: SupabaseClient, scope: ProviderUsageScope, event: string, context: Record<string, unknown>) {
  // A timeout can arrive after Postgres committed. Retry only this immutable
  // journal entry, with the same ID; never replay the paid provider operation.
  const row = {
    id: randomUUID(), created_at: new Date().toISOString(),
    level: 'info', source: VE_USAGE_SOURCE, event, message: `VE2 provider accounting: ${event}`,
    request_id: scope.projectId, context: { version: VE_USAGE_VERSION, ...scope, ...context },
  };
  let failureCode = 'unknown';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { error } = await db.from('application_logs')
        .upsert(row, { onConflict: 'id', ignoreDuplicates: true }).abortSignal(AbortSignal.timeout(10_000));
      if (!error) return;
      throw error;
    } catch (error) {
      // Never log the raw DB error: messages may include URLs or row data.
      const failure = error as { code?: unknown; name?: unknown; message?: unknown; cause?: { code?: unknown } } | null;
      const code = failure?.cause?.code ?? failure?.code;
      failureCode = typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code
        : /abort|timeout/i.test(String(failure?.name ?? '') + String(failure?.message ?? '')) ? 'DEADLINE' : 'unknown';
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
  }
  console.warn(`[ve-cost] journal persistence failed (event=${event}, code=${failureCode}, attempts=3, job=${scope.jobId})`);
  throw new ProviderUsageWriteError();
}

function eventFields(event: ProviderUsageEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of [
    'attemptId', 'provider', 'phase', 'status', 'requestedModel', 'actualModel', 'providerRequestId',
    'httpStatus', 'promptTokens', 'completionTokens', 'cachedTokens', 'reportedCostUsd', 'estimatedCostUsd', 'serperCredits',
  ] as const) if (event[key] !== undefined) out[key] = event[key];
  return out;
}

/** Establish accounting before work starts. A lost CAS response must not fail
 * preparation or overwrite another claim's payload. Only this write retries. */
async function initializeUsageOrigin(db: SupabaseClient, job: VeJob, runId: string) {
  const origin = { runId, startedAt: new Date().toISOString() };
  const payload = { ...job.payload, provider_usage_origin: origin };
  const signal = getVeActiveJobSignal();
  const deadline = () => signal
    ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
  const sameClaim = (startedAt: string | null) => startedAt === (job.started_at ?? null)
    || (startedAt != null && job.started_at != null && Date.parse(startedAt) === Date.parse(job.started_at));
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted();
    try {
      let update = db.from('ve_jobs').update({ payload })
        .eq('id', job.id).eq('status', 'running').is('payload->>provider_usage_origin', null);
      update = job.started_at == null ? update.is('started_at', null) : update.eq('started_at', job.started_at);
      const { data, error } = await update.select('id').abortSignal(deadline()).maybeSingle();
      signal?.throwIfAborted();
      if (!error && data) { job.payload = payload; return origin; }
    } catch { signal?.throwIfAborted(); }

    // The write can commit even if its response was lost. Confirm the exact
    // origin before retrying; never erase a cancellation or a newer claim.
    let saved: { status: string; started_at: string | null; payload: Record<string, unknown> } | null | undefined;
    try {
      const { data, error } = await db.from('ve_jobs').select('status,started_at,payload')
        .eq('id', job.id).abortSignal(deadline()).maybeSingle();
      signal?.throwIfAborted();
      if (!error) saved = data;
    } catch { signal?.throwIfAborted(); }
    if (saved !== undefined) {
      if (!saved || saved.status !== 'running' || !sameClaim(saved.started_at)) throw new ProviderUsageWriteError();
      const savedOrigin = saved.payload?.provider_usage_origin as { runId?: unknown } | null | undefined;
      if (savedOrigin?.runId === runId) { job.payload = saved.payload; return origin; }
      if (savedOrigin != null) throw new ProviderUsageWriteError();
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
  }
  console.warn(`[ve-cost] journal persistence failed (event=usage_origin, attempts=3, job=${job.id})`);
  throw new ProviderUsageWriteError();
}

/** A self-requeue is a finished invocation, even though its ve_jobs row remains pending. */
export async function withVeCostTelemetry<T>(db: SupabaseClient, job: VeJob, work: () => Promise<T>,
  /** Every provider attempt start/finish proves the stage is alive (worker inactivity guard). */
  onProviderEvent?: () => void): Promise<T> {
  const scope: ProviderUsageScope = {
    projectId: job.project_id, jobId: job.id, stage: job.stage,
    ...(identifier(job.payload.base_id) ? { baseId: String(job.payload.base_id) } : {}),
  };
  const runId = randomUUID();
  let origin = job.payload.provider_usage_origin as { runId?: unknown } | undefined;
  if (origin === undefined || origin === null) {
    origin = await initializeUsageOrigin(db, job, runId);
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
      (currentScope, event) => { onProviderEvent?.(); return append(db, currentScope, event.phase, { runId, ...eventFields(event) }); }, work);
    outcome = 'returned';
    return result;
  } finally {
    const children = job.stage === 'base_collect' ? await childSnapshot(db, scope.baseId) : undefined;
    // A missing finish marker remains an explicit accounting gap after process death or failed persistence.
    await append(db, scope, 'stage_finished', { runId, outcome, ...(children ? { children } : {}) });
  }
}

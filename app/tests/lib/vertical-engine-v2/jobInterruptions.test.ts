/** @jest-environment node */

/**
 * 23.09.2026: before the bounded stage database, a hang ended in a process
 * exit, and startup recovery returned the job to the queue without counting
 * it (1cd7fd6a hung 4 times in 2 hours, attempts stayed 0). Once a stalled
 * read or the inactivity guard ends the stage with an error, the same hang
 * reaches failJob — and must not spend the job's attempts, or the fifth hang
 * would fail a base that is still collecting.
 */
import { createVeStageSupabase } from '@/lib/verticalEngineV2/stageDb';
import {
  clearVeJobInterruptions,
  planVeJobFailure,
  RETRYABLE_MAX_ATTEMPTS,
  VE_JOB_FREE_INTERRUPTIONS,
} from '@/lib/verticalEngineV2/jobRetry';
import { VeLlmRateLimitError } from '@/lib/verticalEngineV2/llmRateLimit';
import { VeJobInactivityError } from '@/lib/verticalEngineV2/workerLiveness';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import { readRelevanceCheckpoint } from '@/lib/verticalEngineV2/relevanceCheckpoint';
import { retryVeJobFinalization, transitionVeJobFailure } from '@/lib/verticalEngineV2/jobFailureTransition';
import { createVeJobPool, canRunVeJob } from '@/lib/verticalEngineV2/jobQueue';
import type { VeJob } from '@/lib/verticalEngineV2/types';

const NOW = Date.parse('2026-09-23T09:26:23.776Z');
// The payload of job 896efda6 (base 0482f88b) on production.
const payload = {
  limit: 5000, base_id: '0482f88b-0c6d-4509-a6ce-22278847ad21', ready_target: 500,
  hypothesis_id: 'h1', collection_mode: 'target', provider_usage_origin: { runId: 'r1', startedAt: '2026-09-23T05:42:33Z' },
};
const job = (attempts: number, extra: Record<string, unknown> = {}): { id: string; attempts: number; payload: Record<string, unknown> } =>
  ({ id: '896efda6-4713-49e6-8003-bdc29510fd9d', attempts, payload: { ...payload, ...extra } });

/** The message a stage throws after its read of the project's other bases stalled. */
async function stalledReadMessage(): Promise<string> {
  const db = createVeStageSupabase({ url: 'https://db.example.test', serviceRoleKey: 'k', jobSignal: () => null, timeoutMs: 40,
    fetchImpl: (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('[{"data":[')); },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch });
  const { error } = await db.from('ve_bases').select('data,columns,source,hypothesis_id,target_checkpoint')
    .eq('project_id', 'p1').neq('id', payload.base_id);
  return `Не удалось прочитать другие базы проекта: ${error?.message}`;
}

describe('VE2 job interruptions do not spend attempts', () => {
  it('resumes metering failures only for collection with a valid saved checkpoint, and bounds repeated failures', () => {
    const checkpoint = readRelevanceCheckpoint(null, 'a'.repeat(64));
    checkpoint.verdicts['b'.repeat(64)] = { version: 2, status: 'needs_review', reason: 'Saved check', evidence: [], context_hash: checkpoint.context_hash };
    const collect = { ...job(0), stage: 'base_collect' as const, result: { relevance_checkpoint: checkpoint } };
    const error = new Error('Provider usage journal could not be saved.');
    expect(planVeJobFailure(collect, error, NOW)).toMatchObject({ status: 'pending', attempts: 1, retryable: true,
      runAfter: new Date(NOW + 30_000).toISOString() });
    expect(planVeJobFailure({ ...collect, attempts: 4 }, error, NOW)).toMatchObject({ status: 'failed', attempts: 5 });
    for (const unsafe of [
      { ...collect, stage: 'site_profile' as const }, { ...collect, result: null },
      { ...collect, result: { relevance_checkpoint: { ...checkpoint, verdicts: {} } } },
      { ...collect, result: { relevance_checkpoint: { ...checkpoint, version: 99 } } },
    ]) expect(planVeJobFailure(unsafe, error, NOW)).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('retries an acknowledged failure transition idempotently and fences off cancellation and a newer claim', async () => {
    const input = { jobId: 'j', startedAt: new Date(NOW).toISOString(), status: 'pending' as const,
      attempts: 1, error: 'fetch failed', finishedAt: null, runAfter: new Date(NOW + 30_000).toISOString(), updatedAt: new Date(NOW).toISOString() };
    for (const startedAt of [input.startedAt, null]) {
      const db = createMockSupabase({ tables: { ve_jobs: [{ id: 'j', status: 'running', started_at: startedAt,
        attempts: 0, result: { checkpoint: 'preserved' } }] } });
      for (let i = 0; i < 2; i++) {
        await expect(transitionVeJobFailure(db as unknown as SupabaseClient, { ...input, startedAt }))
          .resolves.toEqual({ transitioned: true, error: null });
      }
      expect(db.getRows('ve_jobs')[0]).toMatchObject({ status: 'pending', attempts: 1, result: { checkpoint: 'preserved' } });
    }
    for (const row of [
      { id: 'j', status: 'cancelled', started_at: input.startedAt, attempts: 0 },
      { id: 'j', status: 'running', started_at: new Date(NOW + 60_000).toISOString(), attempts: 1 },
      { id: 'j', status: 'done', started_at: input.startedAt, attempts: 0 },
    ]) {
      const db = createMockSupabase({ tables: { ve_jobs: [row] } });
      await expect(transitionVeJobFailure(db as unknown as SupabaseClient, input)).resolves.toEqual({ transitioned: false, error: null });
      expect(db.getRows('ve_jobs')).toEqual([row]);
    }
  });

  it('keeps the queue scope locked during save retries and stops retrying on shutdown without replaying work', async () => {
    jest.useFakeTimers();
    try {
      const jobs = ['a', 'b'].map((id) => ({ id, project_id: 'p', stage: 'base_collect', payload: { base_id: 'same' } }) as unknown as VeJob);
      const writes = jest.fn().mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
      const started: string[] = [];
      const pool = createVeJobPool({ concurrency: 2, idleMs: 10, shouldStop: () => false,
        claim: async (active) => jobs[0] && canRunVeJob(jobs[0], active) ? jobs.shift()! : null,
        run: async (current) => { started.push(current.id); await retryVeJobFinalization({ save: writes, shouldStop: () => false, onError: jest.fn() }); },
        onError: jest.fn(),
      });
      await pool.pollOnce();
      await jest.advanceTimersByTimeAsync(0);
      const waiting = pool.pollOnce();
      await jest.advanceTimersByTimeAsync(10);
      await waiting;
      expect(started).toEqual(['a']);
      await jest.advanceTimersByTimeAsync(15_000);
      await pool.pollOnce();
      await pool.drain();
      expect(started).toEqual(['a', 'b']);
      expect(writes).toHaveBeenCalledTimes(4);
      let stopped = false;
      const failing = jest.fn().mockRejectedValue(new Error('offline'));
      const pending = retryVeJobFinalization({ save: failing, shouldStop: () => stopped, onError: jest.fn() });
      await jest.advanceTimersByTimeAsync(0);
      stopped = true;
      await jest.advanceTimersByTimeAsync(30_000);
      await pending;
      expect(failing).toHaveBeenCalledTimes(1);
    } finally { jest.useRealTimers(); }
  });

  it('a stalled stage database read returns the job to the queue with the same attempts', async () => {
    const plan = planVeJobFailure(job(4), new Error(await stalledReadMessage()), NOW);
    expect(plan).toMatchObject({ status: 'pending', attempts: 4, interruption: { count: 1, free: true } });
    expect(plan.payload).toEqual({ ...payload, interruptions: 1 });
    // Backoff as for a transient error, not an immediate reclaim.
    expect(plan.runAfter).toBe(new Date(NOW + 30_000).toISOString());
  });

  it('an inactivity-guard abort returns the job to the queue with the same attempts', () => {
    const plan = planVeJobFailure(job(4), new VeJobInactivityError('VE2 base_collect inactivity timeout after 1200000ms'), NOW);
    expect(plan).toMatchObject({ status: 'pending', attempts: 4, interruption: { count: 1, free: true } });
  });

  it('a lost stage database connection returns the job to the queue with the same attempts', () => {
    const plan = planVeJobFailure(job(2),
      new Error('ve_bases checkpoint: VeStageDbConnectionError: VE2 database PATCH request connection lost: terminated (UND_ERR_SOCKET)'), NOW);
    expect(plan).toMatchObject({ status: 'pending', attempts: 2, retryable: true });
  });

  it('many hangs in a row do not fail the base; only past the limit do they count as attempts', () => {
    let current = job(0);
    for (let hang = 1; hang <= VE_JOB_FREE_INTERRUPTIONS; hang += 1) {
      const plan = planVeJobFailure(current, new VeJobInactivityError('VE2 base_collect inactivity timeout after 1200000ms'), NOW);
      expect(plan).toMatchObject({ status: 'pending', attempts: 0 });
      current = { ...current, payload: plan.payload! };
    }
    // The limit only stops an endless loop of the same hang.
    const spent = planVeJobFailure({ ...current, attempts: RETRYABLE_MAX_ATTEMPTS - 1 },
      new VeJobInactivityError('VE2 base_collect inactivity timeout after 1200000ms'), NOW);
    expect(spent).toMatchObject({ status: 'failed', attempts: RETRYABLE_MAX_ATTEMPTS, interruption: { count: VE_JOB_FREE_INTERRUPTIONS + 1, free: false } });
  });

  it('a normal run closes the series of interruptions', () => {
    expect(clearVeJobInterruptions({ ...payload, interruptions: 3 })).toEqual(payload);
    expect(clearVeJobInterruptions(payload)).toBeNull();
  });

  it('other failures are counted as before', () => {
    expect(planVeJobFailure(job(4), new Error('Serper transient: 503 Service Unavailable'), NOW))
      .toMatchObject({ status: 'failed', attempts: 5, interruption: null });
    expect(planVeJobFailure(job(0), new Error('ve_bases update: new row violates check constraint'), NOW))
      .toMatchObject({ status: 'pending', attempts: 1, retryable: false, runAfter: new Date(NOW).toISOString() });
    expect(planVeJobFailure(job(4), new VeLlmRateLimitError(NOW + 60_000, true), NOW))
      .toMatchObject({ status: 'pending', attempts: 4 });
    expect(planVeJobFailure(job(0), new Error('ve_bases update: new row violates check constraint'), NOW).payload).toBeUndefined();
  });
});

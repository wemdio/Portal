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
import { retryVeJobFinalization, transitionVeJobFailure, VeJobQueuePersistenceError } from '@/lib/verticalEngineV2/jobFailureTransition';
import { requeueVeJob } from '@/lib/verticalEngineV2/stages/shared';
import { createVeJobPool, canRunVeJob, claimVeJob } from '@/lib/verticalEngineV2/jobQueue';
import type { VeJob } from '@/lib/verticalEngineV2/types';
import { deferVeRequestyRecoveryWhileIneligible, planVeRequestyBillingWait, resumeVeRequestyBillingJobs, VeRequestyBillingError,
  veRequestyCreditImproved, VE_REQUESTY_BILLING_RUN_AFTER } from '@/lib/verticalEngineV2/requestyBillingRecovery';
import type { VeRequestyBalanceResult, VeRequestyCreditSignal } from '@/lib/verticalEngineV2/requestyBalance';

const NOW = Date.parse('2026-09-23T09:26:23.776Z');
// The payload of job 896efda6 (base 0482f88b) on production.
const payload = {
  limit: 5000, base_id: '0482f88b-0c6d-4509-a6ce-22278847ad21', ready_target: 500,
  hypothesis_id: 'h1', collection_mode: 'target', provider_usage_origin: { runId: 'r1', startedAt: '2026-09-23T05:42:33Z' },
};
const job = (attempts: number, extra: Record<string, unknown> = {}): { id: string; attempts: number; payload: Record<string, unknown> } =>
  ({ id: '896efda6-4713-49e6-8003-bdc29510fd9d', attempts, payload: { ...payload, ...extra } });

const BILLING_KEY = 'a'.repeat(64);
const billingCredit = (balanceUsd = 50, monthlySpendUsd = 10, monthlyLimitUsd = 0): VeRequestyCreditSignal =>
  ({ balanceUsd, monthlySpendUsd, monthlyLimitUsd });
const fundedProbe = (creditSignal = billingCredit()): VeRequestyBalanceResult => ({
  status: 'usable', reason: 'credit_available', keyFingerprint: BILLING_KEY,
  ...creditSignal, creditSignal, availableCreditUsd: Math.min(creditSignal.balanceUsd,
    creditSignal.monthlyLimitUsd === 0 ? creditSignal.balanceUsd : creditSignal.monthlyLimitUsd - creditSignal.monthlySpendUsd),
});
const waitingJob = (id = 'billing-job', extraWait: Record<string, unknown> = {}) => ({
  id, project_id: 'billing-project', stage: 'base_collect', status: 'pending', attempts: 3,
  updated_at: new Date(NOW).toISOString(), run_after: VE_REQUESTY_BILLING_RUN_AFTER,
  error: 'Requesty 402: insufficient balance', finished_at: null, result: { paid_checkpoint: { completed: [1, 2] } },
  payload: { ...payload, requesty_billing_wait: { version: 1, key_fingerprint: BILLING_KEY,
    blocked_at: new Date(NOW - 1_000).toISOString(), ...extraWait } },
});
const billingBase = () => ({ id: payload.base_id, project_id: 'billing-project', hypothesis_id: payload.hypothesis_id, status: 'collecting',
  row_count: 37, data: [['saved company', 'saved email']], collect_info: { budget: 100, checkpoint: 'paid' } });
const legacyBillingPlan = (id = 'legacy-supply') => ({ id, status: 'error', item_id: 'existing-launch',
  updated_at: new Date(NOW - 86_400_000).toISOString(), last_error: 'Requesty 402: insufficient balance' });
const legacyBillingPreview = (id = 'legacy-preview') => ({ project_id: 'billing-project', hypothesis_id: id,
  base_id: payload.base_id, status: 'error', paused_at: null, cancelled_at: null,
  updated_at: new Date(NOW - 86_400_000).toISOString(), last_error: 'Requesty 402: insufficient balance' });
function withAbortableRpc(db: ReturnType<typeof createMockSupabase>) {
  const rpc = db.rpc.bind(db);
  db.rpc = ((...args: Parameters<typeof rpc>) => {
    const pending = rpc(...args);
    return Object.assign(pending, { abortSignal: () => pending });
  }) as typeof db.rpc;
  return db;
}

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
  it('parks only attributable Requesty failures without losing saved work or spending attempts', async () => {
    const original = { ...waitingJob(), status: 'running', started_at: new Date(NOW - 500).toISOString(),
      payload: { ...payload, requesty_billing_recovery: { key_fingerprint: BILLING_KEY, credit_signal: billingCredit() } } };
    const failure = new VeRequestyBillingError('Requesty 402: insufficient balance', BILLING_KEY);
    const planned = planVeRequestyBillingWait(original, failure, NOW)!;
    expect(planned).toMatchObject({ status: 'pending', attempts: 3, attemptCap: 3,
      retryable: false, runAfter: VE_REQUESTY_BILLING_RUN_AFTER,
      payload: { ...payload, requesty_billing_wait: { key_fingerprint: BILLING_KEY, last_credit: billingCredit() } } });
    expect(planVeRequestyBillingWait(original, new Error(failure.message), NOW)).toBeNull();
    expect(planVeRequestyBillingWait(original, new VeRequestyBillingError(failure.message, 'not-a-fingerprint'), NOW)).toBeNull();
    // An earlier successful HTTP response is not proof of saved progress.
    // A repeated billing failure always retains the last recovery baseline.
    const sameWork = { ...original, result: { checkpoint: 'unchanged' } };
    const repeated = planVeRequestyBillingWait(sameWork, failure, NOW + 1_000)!;
    expect(repeated.payload!.requesty_billing_wait).toHaveProperty('last_credit', billingCredit());
    const changedKey = planVeRequestyBillingWait(original, new VeRequestyBillingError(failure.message, 'b'.repeat(64)), NOW)!;
    expect(changedKey.payload!.requesty_billing_wait).not.toHaveProperty('last_credit');

    const db = createMockSupabase({ tables: { ve_jobs: [original], ve_bases: [billingBase()] } });
    await expect(transitionVeJobFailure(db as unknown as SupabaseClient, {
      jobId: original.id, startedAt: original.started_at, status: planned.status,
      attempts: planned.attempts, error: failure.message, finishedAt: null,
      runAfter: planned.runAfter, updatedAt: new Date(NOW).toISOString(), payload: planned.payload,
    })).resolves.toEqual({ transitioned: true, error: null });
    const parked = db.getRows('ve_jobs')[0] as unknown as VeJob;
    expect(parked).toMatchObject({ id: original.id, status: 'pending', attempts: 3,
      result: original.result, run_after: VE_REQUESTY_BILLING_RUN_AFTER });
    expect(canRunVeJob(parked, [])).toBe(false);
    // An accidental run_after change cannot bypass the separate wait marker.
    expect(canRunVeJob({ ...parked, payload: { ...parked.payload, requesty_billing_wait: false } }, [])).toBe(false);
    await expect(claimVeJob(db as unknown as SupabaseClient, new Date(NOW + 86_400_000))).resolves.toBeNull();
    expect(db.getRows('ve_bases')).toEqual([billingBase()]);
    expect(db.inserts).toEqual([]);
  });

  it('checks credit only for waiting jobs and releases the same job once per real credit improvement', async () => {
    const empty = createMockSupabase({ tables: { ve_jobs: [] } });
    const probe = jest.fn<Promise<VeRequestyBalanceResult>, []>().mockResolvedValue(fundedProbe());
    const sweep = (db: ReturnType<typeof createMockSupabase>, now = NOW + 60_000) => resumeVeRequestyBillingJobs(
      db as unknown as SupabaseClient, { now: new Date(now), probe, keyFingerprint: BILLING_KEY });
    await expect(sweep(empty)).resolves.toMatchObject({ waiting: 0, resumed: 0, reason: 'no_work' });
    expect(probe).not.toHaveBeenCalled();
    const zero = billingCredit(0);
    for (const unavailable of [
      { status: 'blocked', reason: 'insufficient_balance', keyFingerprint: BILLING_KEY, ...zero,
        creditSignal: zero, availableCreditUsd: 0 },
      { status: 'unavailable', reason: 'management_forbidden', keyFingerprint: BILLING_KEY },
      { ...fundedProbe(), keyFingerprint: 'b'.repeat(64) },
    ] as VeRequestyBalanceResult[]) {
      const db = createMockSupabase({ tables: { ve_jobs: [waitingJob()], ve_bases: [billingBase()] } });
      probe.mockResolvedValue(unavailable);
      expect((await sweep(db)).resumed).toBe(0);
      expect(db.getRows('ve_jobs')[0]).toMatchObject({ status: 'pending', attempts: 3,
        run_after: VE_REQUESTY_BILLING_RUN_AFTER, result: waitingJob().result });
    }
    for (const lastCredit of [false, '', {}, { balanceUsd: 20 },
      { balanceUsd: '20', monthlySpendUsd: 10, monthlyLimitUsd: 0 }, billingCredit(-1)]) {
      const invalid = waitingJob('corrupt-wait', { last_credit: lastCredit });
      const corrupt = createMockSupabase({ tables: { ve_jobs: [invalid], ve_bases: [billingBase()] } });
      probe.mockResolvedValue(fundedProbe());
      expect((await sweep(corrupt)).resumed).toBe(0);
      expect(corrupt.getRows('ve_jobs')).toEqual([invalid]);
      expect(corrupt.mutations).toEqual([]);
    }
    const old = waitingJob();
    const otherKey = { ...waitingJob('other-key'), payload: { ...payload, requesty_billing_wait: {
      ...old.payload.requesty_billing_wait, key_fingerprint: 'b'.repeat(64) } } };
    const db = createMockSupabase({ enforceQueryWindows: true,
      tables: { ve_jobs: [old, otherKey], ve_bases: [billingBase()], ve_campaigns: [{ id: 'untouched', status: 'paused' }] } });
    probe.mockResolvedValue(fundedProbe());
    expect(await sweep(db)).toMatchObject({ waiting: 1, resumed: 1 });
    expect(db.getRows('ve_jobs')).toHaveLength(2);
    expect(db.getRows('ve_jobs')[0]).toMatchObject({ id: old.id, status: 'pending', attempts: 3,
      result: old.result, error: null, finished_at: null, run_after: new Date(NOW + 60_000).toISOString(),
      payload: { ...payload, requesty_billing_wait: null,
        requesty_billing_recovery: { key_fingerprint: BILLING_KEY, credit_signal: billingCredit() } } });
    expect(db.getRows('ve_jobs')[1]).toEqual(otherKey);
    expect(db.getRows('ve_bases')).toEqual([billingBase()]);
    expect(db.getRows('ve_campaigns')).toEqual([{ id: 'untouched', status: 'paused' }]);
    expect(db.inserts).toEqual([]);
    expect(db.mutations.every((item) => item.table === 've_jobs' && item.kind === 'update')).toBe(true);
    probe.mockClear();
    expect((await sweep(db)).resumed).toBe(0);
    expect(probe).not.toHaveBeenCalled();

    // Another 402 at the same still-positive balance must not loop. Observe
    // reduced credit without waking, then allow a later genuine top-up.
    const again = createMockSupabase({ tables: { ve_jobs: [waitingJob('again', { last_credit: billingCredit() })],
      ve_bases: [billingBase()] } });
    probe.mockResolvedValue(fundedProbe());
    expect((await sweep(again)).resumed).toBe(0);
    probe.mockResolvedValue(fundedProbe(billingCredit(20, 40)));
    expect((await sweep(again, NOW + 120_000)).resumed).toBe(0);
    expect(again.getRows('ve_jobs')[0]).toMatchObject({ payload: { requesty_billing_wait: {
      last_credit: billingCredit(20, 40),
    } } });
    probe.mockResolvedValue(fundedProbe(billingCredit(30, 40)));
    expect((await sweep(again, NOW + 180_000)).resumed).toBe(1);
    const released = again.getRows('ve_jobs')[0] as unknown as VeJob;
    const secondFailure = planVeRequestyBillingWait(released,
      new VeRequestyBillingError('Requesty 402: insufficient balance', BILLING_KEY), NOW + 181_000)!;
    const stillBlocked = createMockSupabase({ tables: { ve_jobs: [{ ...released,
      payload: secondFailure.payload, run_after: secondFailure.runAfter }], ve_bases: [billingBase()] } });
    for (let i = 0; i < 3; i++) {
      expect((await sweep(stillBlocked, NOW + 240_000 + i * 60_000)).resumed).toBe(0);
      expect(stillBlocked.getRows('ve_jobs')[0]).toMatchObject({ payload: { requesty_billing_wait: {
        last_credit: billingCredit(30, 40),
      } } });
    }
    const legacyRecovery = { ...waitingJob('legacy-repeated'), payload: { ...payload,
      collection_mode: 'supply', supply_batch_id: 'legacy-repeat-batch',
      requesty_billing_recovery: { version: 1, source: 'legacy_supply', key_fingerprint: BILLING_KEY,
        credit_signal: billingCredit() } } };
    const legacyWait = planVeRequestyBillingWait(legacyRecovery,
      new VeRequestyBillingError('Requesty 402: insufficient balance', BILLING_KEY), NOW)!;
    const legacyAgain = createMockSupabase({ tables: {
      ve_jobs: [{ ...legacyRecovery, payload: legacyWait.payload, run_after: legacyWait.runAfter }],
      ve_bases: [billingBase()],
      ve_contact_supply_batches: [{ id: 'legacy-repeat-batch', base_id: payload.base_id, plan_id: 'legacy-repeat-plan', status: 'collecting' }],
      ve_contact_supply_plans: [{ id: 'legacy-repeat-plan', project_id: legacyRecovery.project_id,
        status: 'active', item_id: 'legacy-item', hypothesis_id: payload.hypothesis_id }],
    } });
    probe.mockResolvedValue(fundedProbe());
    expect((await sweep(legacyAgain)).resumed).toBe(0);
    probe.mockResolvedValue(fundedProbe(billingCredit(60)));
    expect((await sweep(legacyAgain)).resumed).toBe(1);
    expect(legacyAgain.getRows('ve_jobs')[0].payload).toHaveProperty('requesty_billing_recovery.source', 'legacy_supply');
    expect(legacyAgain.getRows('ve_jobs')[0].payload).toHaveProperty('requesty_billing_recovery.credit_signal', billingCredit(60));
    expect(veRequestyCreditImproved(billingCredit(50, 20, 20), billingCredit(40, 20, 30))).toBe(true);
    expect(veRequestyCreditImproved(billingCredit(50, 20, 20), billingCredit(40, 0, 20))).toBe(true);
    expect(veRequestyCreditImproved(billingCredit(50, 20, 20), billingCredit(40, 20, 0))).toBe(true);
    expect(veRequestyCreditImproved(billingCredit(50, 20, 0), billingCredit(40, 21, 0))).toBe(false);

    const many = createMockSupabase({ enforceQueryWindows: true, tables: {
      ve_jobs: Array.from({ length: 105 }, (_, i) => ({ ...waitingJob(`wait-${String(i).padStart(3, '0')}`),
        stage: 'site_profile', payload: { requesty_billing_wait: waitingJob().payload.requesty_billing_wait } })),
    } });
    probe.mockReset().mockResolvedValue(fundedProbe());
    expect(await sweep(many)).toMatchObject({ waiting: 105, resumed: 4 });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(await sweep(many, NOW + 120_000)).toMatchObject({ waiting: 101, resumed: 4 });
    expect(many.inserts).toEqual([]);

    // Historical source failures use the same one probe, but only the atomic
    // RPC may restore their paid base/batch/job. Never use a generic status
    // update or create a replacement source when the RPC refuses its CAS.
    const nonBilling = createMockSupabase({ tables: { ve_contact_supply_plans: [
      { ...legacyBillingPlan('http-404'), last_error: 'Catalog HTTP 404' },
      { ...legacyBillingPlan('other-provider'), last_error: 'Other provider 402: payment required' },
      { ...legacyBillingPlan('mixed-provider'), last_error: 'Requesty timeout; Serper 402: insufficient balance' },
      { ...legacyBillingPlan('not-402'), last_error: 'Requesty HTTP 4020: unexpected response' },
      { ...legacyBillingPlan('manual-pause'), status: 'paused' },
      { ...legacyBillingPlan('never-launched'), item_id: null },
    ] } });
    probe.mockClear();
    expect(await sweep(nonBilling)).toMatchObject({ resumed: 0, reason: 'no_work' });
    expect(probe).not.toHaveBeenCalled();
    expect(nonBilling.rpcCalls).toEqual([]);
    expect(nonBilling.mutations).toEqual([]);
    for (const blocked of [
      { status: 'blocked', reason: 'insufficient_balance', keyFingerprint: BILLING_KEY, ...zero,
        creditSignal: zero, availableCreditUsd: 0 },
      { status: 'unavailable', reason: 'management_forbidden', keyFingerprint: BILLING_KEY },
      { ...fundedProbe(), keyFingerprint: 'b'.repeat(64) },
    ] as VeRequestyBalanceResult[]) {
      const held = createMockSupabase({ tables: { ve_contact_supply_plans: [legacyBillingPlan()] } });
      probe.mockClear().mockResolvedValue(blocked);
      expect((await sweep(held)).resumed).toBe(0);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(held.rpcCalls).toEqual([]);
      expect(held.mutations).toEqual([]);
    }
    const historical = legacyBillingPlan();
    let acceptedLegacy = false;
    const legacyDb = withAbortableRpc(createMockSupabase({ tables: {
      ve_contact_supply_plans: [historical], ve_jobs: [{ ...waitingJob('old-done'), status: 'done', payload }],
      ve_bases: [{ ...billingBase(), status: 'failed' }], ve_campaigns: [{ id: 'existing', status: 'active' }],
    }, rpcHandlers: { ve_resume_legacy_requesty_supply: (params) => {
      expect(params).toMatchObject({ p_plan_id: historical.id, p_expected_updated_at: historical.updated_at,
        p_key_fingerprint: BILLING_KEY, p_credit_signal: billingCredit() });
      expect(params.p_credit_observed_at).toBe(new Date(NOW + 60_000).toISOString());
      expect(params.p_now).toBe(new Date(NOW + 60_000).toISOString());
      const resumed = !acceptedLegacy;
      acceptedLegacy = true;
      return { data: { resumed, reason: resumed ? 'resumed' : 'stale' } };
    } } }));
    const savedLegacy = ['ve_contact_supply_plans', 've_jobs', 've_bases', 've_campaigns']
      .map((table) => legacyDb.getRows(table));
    probe.mockClear().mockResolvedValue(fundedProbe());
    expect((await sweep(legacyDb)).resumed).toBe(1);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(legacyDb.rpcCalls).toHaveLength(1);
    expect((await sweep(legacyDb)).resumed).toBe(0);
    expect(legacyDb.rpcCalls).toHaveLength(2);
    expect(legacyDb.rpcCalls.every((call) => call.fn === 've_resume_legacy_requesty_supply')).toBe(true);
    expect(['ve_contact_supply_plans', 've_jobs', 've_bases', 've_campaigns']
      .map((table) => legacyDb.getRows(table))).toEqual(savedLegacy);
    expect(legacyDb.mutations).toEqual([]);
    for (const reason of ['paused', 'cancelled', 'stale', 'malformed_checkpoint', 'awaiting_credit_change']) {
      const refused = withAbortableRpc(createMockSupabase({ tables: {
        ve_contact_supply_plans: [legacyBillingPlan(reason)],
      }, rpcHandlers: { ve_resume_legacy_requesty_supply: () => ({ data: { resumed: false, reason } }) } }));
      expect((await sweep(refused)).resumed).toBe(0);
      expect(refused.rpcCalls).toHaveLength(1);
      expect(refused.mutations).toEqual([]);
    }
    for (const response of [
      { data: null, error: { message: 'connection lost after commit' } },
      { data: null },
      { data: { resumed: 'true', reason: 'invalid response' } },
    ]) {
      const uncertain = withAbortableRpc(createMockSupabase({ tables: {
        ve_contact_supply_plans: [legacyBillingPlan('uncertain-a'), legacyBillingPlan('uncertain-b')],
      }, rpcHandlers: { ve_resume_legacy_requesty_supply: () => response } }));
      await expect(sweep(uncertain)).rejects.toThrow();
      // The first transaction may have committed. Do not buy more recovery
      // work when its response cannot confirm whether it consumed a slot.
      expect(uncertain.rpcCalls).toHaveLength(1);
      expect(uncertain.mutations).toEqual([]);
    }
    const refusedMany = withAbortableRpc(createMockSupabase({ enforceQueryWindows: true, tables: {
      ve_contact_supply_plans: Array.from({ length: 25 }, (_, i) => legacyBillingPlan(`refused-${String(i).padStart(3, '0')}`)),
    }, rpcHandlers: { ve_resume_legacy_requesty_supply: () => ({ data: { resumed: false, reason: 'checkpoint_not_resumable' } }) } }));
    probe.mockClear();
    expect((await sweep(refusedMany)).resumed).toBe(0);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(refusedMany.rpcCalls).toHaveLength(20);
    expect((await sweep(refusedMany)).resumed).toBe(0);
    expect(refusedMany.rpcCalls).toHaveLength(25);
    expect(new Set(refusedMany.rpcCalls.map((call) => call.params.p_plan_id)).size).toBe(25);
    expect(refusedMany.mutations).toEqual([]);
    const scanning = withAbortableRpc(createMockSupabase({ enforceQueryWindows: true, tables: {
      ve_contact_supply_plans: [
        ...Array.from({ length: 105 }, (_, i) => ({ ...legacyBillingPlan(`scan-${String(i).padStart(3, '0')}`),
          last_error: 'Catalog HTTP 404' })),
        legacyBillingPlan('scan-105'),
      ],
    }, rpcHandlers: { ve_resume_legacy_requesty_supply: () => ({ data: { resumed: true, reason: 'resumed' } }) } }));
    probe.mockClear();
    expect((await sweep(scanning)).resumed).toBe(0);
    expect(probe).not.toHaveBeenCalled();
    expect((await sweep(scanning)).resumed).toBe(1);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(scanning.rpcCalls).toHaveLength(1);
    expect(scanning.mutations).toEqual([]);
    for (const nativeCount of [3, 4]) {
      const mixed = withAbortableRpc(createMockSupabase({ enforceQueryWindows: true, tables: {
        ve_jobs: Array.from({ length: nativeCount }, (_, i) => ({ ...waitingJob(`native-${i}`),
          stage: 'site_profile', payload: { requesty_billing_wait: waitingJob().payload.requesty_billing_wait } })),
        ve_contact_supply_plans: [legacyBillingPlan('legacy-a'), legacyBillingPlan('legacy-b')],
      }, rpcHandlers: { ve_resume_legacy_requesty_supply: () => ({ data: { resumed: true, reason: 'resumed' } }) } }));
      probe.mockClear();
      expect((await sweep(mixed)).resumed).toBe(4);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(mixed.rpcCalls).toHaveLength(4 - nativeCount);
      expect(mixed.mutations.every((change) => change.kind === 'update' && change.table === 've_jobs')).toBe(true);
      expect(mixed.inserts).toEqual([]);
    }
    const previewRow = legacyBillingPreview();
    for (const response of [{ data: { resumed: true } }, { data: { resumed: false, reason: 'paused' } },
      { data: null, error: { message: 'commit response lost' } }]) {
      const previewDb = withAbortableRpc(createMockSupabase({ tables: { ve_outreach_preparations: [previewRow] },
        rpcHandlers: { ve_resume_legacy_requesty_preview: (params) => {
          expect(params).toMatchObject({ p_project_id: previewRow.project_id, p_hypothesis_id: previewRow.hypothesis_id,
            p_base_id: previewRow.base_id, p_expected_updated_at: previewRow.updated_at,
            p_key_fingerprint: BILLING_KEY, p_credit_signal: billingCredit() });
          return response;
        } } }));
      probe.mockClear().mockResolvedValue(fundedProbe());
      if (response.error) await expect(sweep(previewDb)).rejects.toThrow('historical preview result unconfirmed');
      else expect((await sweep(previewDb)).resumed).toBe(response.data!.resumed ? 1 : 0);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(previewDb.rpcCalls).toHaveLength(1);
      expect(previewDb.mutations).toEqual([]);
    }
    for (const blocked of [{ status: 'unavailable', reason: 'management_forbidden', keyFingerprint: BILLING_KEY },
      { status: 'blocked', reason: 'insufficient_balance', keyFingerprint: BILLING_KEY, ...zero,
        creditSignal: zero, availableCreditUsd: 0 }, { ...fundedProbe(), keyFingerprint: 'b'.repeat(64) }] as VeRequestyBalanceResult[]) {
      const blockedDb = createMockSupabase({ tables: { ve_outreach_preparations: [previewRow] } });
      probe.mockResolvedValue(blocked);
      expect((await sweep(blockedDb)).resumed).toBe(0);
      expect(blockedDb.rpcCalls).toEqual([]);
      expect(blockedDb.mutations).toEqual([]);
    }
    const previewNoWork = createMockSupabase({ tables: { ve_outreach_preparations: [
      { ...previewRow, paused_at: new Date(NOW).toISOString() },
      { ...legacyBillingPreview('cancelled'), cancelled_at: new Date(NOW).toISOString() },
      { ...legacyBillingPreview('other-error'), last_error: 'Requesty timeout; Serper 402' },
    ] } });
    probe.mockClear();
    expect((await sweep(previewNoWork)).reason).toBe('no_work');
    expect(probe).not.toHaveBeenCalled();
    // Permanent historical refusals must not monopolize the shared RPC cap.
    const fairDb = withAbortableRpc(createMockSupabase({ enforceQueryWindows: true, tables: {
      ve_contact_supply_plans: Array.from({ length: 20 }, (_, i) => legacyBillingPlan(`bad-${i}`)),
      ve_outreach_preparations: [previewRow],
    }, rpcHandlers: { ve_resume_legacy_requesty_supply: () => ({ data: { resumed: false } }),
      ve_resume_legacy_requesty_preview: () => ({ data: { resumed: true } }) } }));
    probe.mockClear().mockResolvedValue(fundedProbe());
    expect((await sweep(fairDb)).resumed).toBe(1);
    expect(fairDb.rpcCalls).toHaveLength(20);
    expect(fairDb.rpcCalls[1].fn).toBe('ve_resume_legacy_requesty_preview');
    expect(probe).toHaveBeenCalledTimes(1);
    const allKinds = withAbortableRpc(createMockSupabase({ enforceQueryWindows: true, tables: {
      ve_jobs: [{ ...waitingJob('native-mix'), stage: 'site_profile',
        payload: { requesty_billing_wait: waitingJob().payload.requesty_billing_wait } }],
      ve_contact_supply_plans: [legacyBillingPlan('mix-a'), legacyBillingPlan('mix-b')],
      ve_outreach_preparations: [previewRow, legacyBillingPreview('another-preview')],
    }, rpcHandlers: { ve_resume_legacy_requesty_supply: () => ({ data: { resumed: true } }),
      ve_resume_legacy_requesty_preview: () => ({ data: { resumed: true } }) } }));
    expect((await sweep(allKinds)).resumed).toBe(4);
    expect(allKinds.rpcCalls).toHaveLength(3);
  });

  it('keeps paused, cancelled and superseded jobs asleep and stops recovery during shutdown', async () => {
    for (const mode of ['paused', 'cancelled_preparation', 'failed_base', 'supply_paused', 'cancelled_job', 'cancel_race', 'new_claim', 'new_wait'] as const) {
      const current = waitingJob();
      const db = createMockSupabase({ tables: {
        ve_jobs: [{ ...current, ...(mode === 'cancelled_job' ? { status: 'cancelled' } : {}) }],
        ve_bases: [{ ...billingBase(), ...(mode === 'failed_base' ? { status: 'failed' } : {}) }],
        ve_outreach_preparations: [{ project_id: current.project_id, base_id: payload.base_id,
          paused_at: mode === 'paused' ? new Date(NOW).toISOString() : null,
          cancelled_at: mode === 'cancelled_preparation' ? new Date(NOW).toISOString() : null }],
        ve_contact_supply_batches: mode === 'supply_paused' ? [{ base_id: payload.base_id, plan_id: 'supply', status: 'collecting' }] : [],
        ve_contact_supply_plans: [{ id: 'supply', project_id: current.project_id, status: 'paused' }],
      }, beforeFirstUpdates: ['cancel_race', 'new_claim', 'new_wait'].includes(mode) ? {
        ve_jobs: (rows) => rows.map((row) => mode === 'cancel_race' ? { ...row, status: 'cancelled' }
          : mode === 'new_claim' ? { ...row, status: 'running', updated_at: new Date(NOW + 1).toISOString() }
            : { ...row, updated_at: new Date(NOW + 1).toISOString(), payload: { ...current.payload,
              requesty_billing_wait: { ...current.payload.requesty_billing_wait, blocked_at: new Date(NOW + 1).toISOString() } } }),
      } : undefined });
      const probe = jest.fn().mockResolvedValue(fundedProbe());
      expect((await resumeVeRequestyBillingJobs(db as unknown as SupabaseClient,
        { now: new Date(NOW + 60_000), probe, keyFingerprint: BILLING_KEY })).resumed).toBe(0);
      expect(db.getRows('ve_jobs')[0]).toMatchObject({ attempts: 3, result: current.result,
        run_after: VE_REQUESTY_BILLING_RUN_AFTER });
      expect(db.getRows('ve_jobs')[0].payload).toHaveProperty('requesty_billing_wait');
      if (mode === 'cancelled_job') expect(probe).not.toHaveBeenCalled();
      if (mode === 'cancel_race') expect(db.getRows('ve_jobs')[0].status).toBe('cancelled');
      if (mode === 'new_claim') expect(db.getRows('ve_jobs')[0].status).toBe('running');
      expect(db.inserts).toEqual([]);
    }
    // A specialist can pause after credit release but before the next claim.
    // The execution guard must hold that same claim without buying work or
    // overriding cancellation, while still allowing a saved terminal no-op.
    for (const mode of ['eligible', 'paused_after_release', 'supply_paused_after_release', 'stale_approval',
      'cancel_after_release', 'new_claim_after_release', 'finished_collection', 'saved_analysis', 'eligibility_unreadable'] as const) {
      const released = { ...waitingJob(), stage: mode === 'finished_collection' ? 'base_collect' : 'base_analyze',
        status: 'running', started_at: new Date(NOW).toISOString(), payload: { ...payload,
          requesty_billing_wait: null, requesty_billing_recovery: { version: 1, key_fingerprint: BILLING_KEY,
            credit_signal: billingCredit(), blocked_at: new Date(NOW - 60_000).toISOString(), resumed_at: new Date(NOW).toISOString() } } };
      const base = { ...billingBase(), status: mode === 'saved_analysis' ? 'analyzed' : 'analyzing' };
      const shouldHold = !['eligible', 'finished_collection', 'saved_analysis'].includes(mode);
      const executionDb = createMockSupabase({ tables: {
        ve_jobs: [released], ve_bases: [base],
        ve_outreach_preparations: [{ project_id: released.project_id, base_id: payload.base_id,
          paused_at: mode === 'paused_after_release' ? new Date(NOW).toISOString() : null, cancelled_at: null }],
        ve_contact_supply_batches: [{ base_id: payload.base_id, plan_id: 'execution-supply', status: 'auditing' }],
        ve_contact_supply_plans: [{ id: 'execution-supply', project_id: released.project_id,
          status: mode === 'supply_paused_after_release' ? 'paused' : 'active' }],
      }, errorTables: mode === 'eligibility_unreadable' ? { ve_bases: 'fetch failed' } : undefined,
      beforeFirstUpdates: ['cancel_after_release', 'new_claim_after_release'].includes(mode) ? {
        ve_jobs: (rows) => rows.map((row) => mode === 'cancel_after_release' ? { ...row, status: 'cancelled' }
          : { ...row, started_at: new Date(NOW + 1_000).toISOString() }),
      } : undefined });
      executionDb.rpc = (() => {
        const result = Promise.resolve({ data: null, error: ['stale_approval', 'cancel_after_release', 'new_claim_after_release'].includes(mode)
          ? { message: 'supply approval rules are stale' } : null });
        return Object.assign(result, { abortSignal: () => result });
      }) as typeof executionDb.rpc;
      expect(await deferVeRequestyRecoveryWhileIneligible(executionDb as unknown as SupabaseClient,
        released as unknown as VeJob, { now: new Date(NOW + 60_000) })).toBe(shouldHold);
      expect(executionDb.getRows('ve_bases')).toEqual([base]);
      expect(executionDb.getRows('ve_jobs')[0]).toMatchObject({ attempts: 3, result: released.result, payload: released.payload });
      if (['paused_after_release', 'supply_paused_after_release', 'stale_approval', 'eligibility_unreadable'].includes(mode)) {
        expect(executionDb.getRows('ve_jobs')[0]).toMatchObject({ status: 'pending', started_at: null,
          run_after: new Date(NOW + 360_000).toISOString() });
      } else if (mode === 'cancel_after_release') expect(executionDb.getRows('ve_jobs')[0].status).toBe('cancelled');
      else if (mode === 'new_claim_after_release') expect(executionDb.getRows('ve_jobs')[0].started_at).toBe(new Date(NOW + 1_000).toISOString());
      else expect(executionDb.mutations).toEqual([]);
      expect(executionDb.inserts).toEqual([]);
    }
    for (const mode of ['eligible', 'hypothesis_paused', 'hypothesis_cancelled', 'campaign_paused',
      'campaign_stale', 'campaign_future', 'campaign_missing', 'batch_missing', 'batch_changed', 'base_id_missing',
      'wrong_collection_mode', 'plan_item_missing', 'plan_hypothesis_missing', 'plan_hypothesis_changed', 'approval_stale'] as const) {
      const released = { ...waitingJob(`legacy-${mode}`), status: 'running', started_at: new Date(NOW).toISOString(),
        payload: { ...payload, ...(mode === 'base_id_missing' ? { base_id: null } : {}),
          collection_mode: mode === 'wrong_collection_mode' ? 'preview' : 'supply', supply_batch_id: 'legacy-batch',
          requesty_billing_wait: null, requesty_billing_recovery: { version: 1, source: 'legacy_supply',
            key_fingerprint: BILLING_KEY, credit_signal: billingCredit(),
            blocked_at: new Date(NOW - 60_000).toISOString(), resumed_at: new Date(NOW).toISOString() } } };
      const executionDb = withAbortableRpc(createMockSupabase({ enforceQueryWindows: true, tables: {
        ve_jobs: [released], ve_bases: [billingBase()],
        ve_outreach_preparations: [{ project_id: released.project_id, hypothesis_id: payload.hypothesis_id,
          base_id: 'initial-preview-not-source-base', paused_at: mode === 'hypothesis_paused' ? new Date(NOW).toISOString() : null,
          cancelled_at: mode === 'hypothesis_cancelled' ? new Date(NOW).toISOString() : null }],
        ve_contact_supply_batches: mode === 'batch_missing' ? []
          : [{ id: mode === 'batch_changed' ? 'other-batch' : 'legacy-batch',
            base_id: payload.base_id, plan_id: 'legacy-plan', status: 'collecting' }],
        ve_contact_supply_plans: [{ id: 'legacy-plan', project_id: released.project_id, status: 'active',
          item_id: mode === 'plan_item_missing' ? null : 'legacy-launch',
          hypothesis_id: mode === 'plan_hypothesis_missing' ? null
            : mode === 'plan_hypothesis_changed' ? 'other-hypothesis' : payload.hypothesis_id }],
        ve_launch_queue_campaigns: mode === 'campaign_missing' ? [] : [{ id: 'campaign', item_id: 'legacy-launch',
          remote_status: mode === 'campaign_paused' ? 2 : 1,
          status_observed_at: new Date(mode === 'campaign_stale' ? NOW - 360_000
            : mode === 'campaign_future' ? NOW + 180_000 : NOW).toISOString() }],
      }, rpcHandlers: { ve_require_contact_supply_active: () => ({ data: null,
        ...(mode === 'approval_stale' ? { error: { message: 'supply approval rules are stale' } } : {}) }) } }));
      expect(await deferVeRequestyRecoveryWhileIneligible(executionDb as unknown as SupabaseClient,
        released as unknown as VeJob, { now: new Date(NOW + 60_000) })).toBe(mode !== 'eligible');
      expect(executionDb.rpcCalls).toHaveLength(['eligible', 'approval_stale'].includes(mode) ? 1 : 0);
      expect(executionDb.getRows('ve_jobs')[0]).toMatchObject({
        status: mode === 'eligible' ? 'running' : 'pending', attempts: released.attempts,
        payload: released.payload, result: released.result,
      });
      expect(executionDb.getRows('ve_bases')).toEqual([billingBase()]);
      expect(executionDb.inserts).toEqual([]);
    }
    for (const mode of ['eligible', 'paused', 'cancelled', 'superseded', 'deselected', 'independent', 'language_changed',
      'hypothesis_rejected', 'hypothesis_missing', 'preparation_missing', 'setup_missing'] as const) {
      const released = { ...waitingJob(`preview-${mode}`), status: 'running', started_at: new Date(NOW).toISOString(),
        payload: { ...payload, collection_mode: 'preview', requesty_billing_wait: null,
          requesty_billing_recovery: { version: 1, source: 'legacy_preview', key_fingerprint: BILLING_KEY,
            credit_signal: billingCredit(), blocked_at: new Date(NOW - 60_000).toISOString(), resumed_at: new Date(NOW).toISOString() } } };
      const p = { project_id: released.project_id, hypothesis_id: payload.hypothesis_id,
        base_id: mode === 'superseded' ? 'new-base' : payload.base_id, language: 'ru',
        independent_control: mode === 'independent', paused_at: mode === 'paused' ? new Date(NOW).toISOString() : null,
        cancelled_at: mode === 'cancelled' ? new Date(NOW).toISOString() : null };
      const previewDb = createMockSupabase({ tables: {
        ve_jobs: [released], ve_bases: [billingBase()], ve_outreach_preparations: mode === 'preparation_missing' ? [] : [p],
        ve_outreach_setups: mode === 'setup_missing' ? [] : [{ project_id: released.project_id,
          language: mode === 'language_changed' ? 'en' : 'ru',
          selected_hypothesis_ids: ['deselected', 'independent'].includes(mode) ? [] : [payload.hypothesis_id] }],
        ve_hypotheses: mode === 'hypothesis_missing' ? [] : [{ id: payload.hypothesis_id, project_id: released.project_id,
          vertical_id: 'vertical', status: mode === 'hypothesis_rejected' ? 'rejected' : 'accepted' }],
      } });
      const shouldHold = !['eligible', 'independent'].includes(mode);
      expect(await deferVeRequestyRecoveryWhileIneligible(previewDb as unknown as SupabaseClient,
        released as unknown as VeJob, { now: new Date(NOW + 60_000) })).toBe(shouldHold);
      expect(previewDb.getRows('ve_jobs')[0]).toMatchObject({ status: shouldHold ? 'pending' : 'running',
        attempts: released.attempts, payload: released.payload, result: released.result });
      expect(previewDb.getRows('ve_bases')).toEqual([billingBase()]);
      expect(previewDb.inserts).toEqual([]);
      if (!shouldHold) {
        const failure = planVeRequestyBillingWait(released, new VeRequestyBillingError('Requesty 402', BILLING_KEY), NOW)!;
        await previewDb.from('ve_jobs').update({ status: 'pending', payload: failure.payload, run_after: failure.runAfter }).eq('id', released.id);
        const run = (balance: number) => resumeVeRequestyBillingJobs(previewDb as unknown as SupabaseClient,
          { now: new Date(NOW + 120_000), keyFingerprint: BILLING_KEY, probe: async () => fundedProbe(billingCredit(balance)) });
        expect((await run(50)).resumed).toBe(0);
        expect((await run(60)).resumed).toBe(1);
        expect(previewDb.getRows('ve_jobs')[0].payload).toHaveProperty('requesty_billing_recovery.source', 'legacy_preview');
      }
    }
    const failedRead = createMockSupabase({ tables: { ve_jobs: [waitingJob()], ve_bases: [billingBase()] },
      errorTables: { ve_bases: 'unavailable' } });
    await expect(resumeVeRequestyBillingJobs(failedRead as unknown as SupabaseClient,
      { probe: async () => fundedProbe(), keyFingerprint: BILLING_KEY })).rejects.toThrow('base read failed');
    expect(failedRead.mutations).toEqual([]);

    for (const stopAt of ['before_read', 'during_probe', 'during_eligibility'] as const) {
      const db = createMockSupabase({ tables: { ve_jobs: [waitingJob()], ve_bases: [billingBase()] } });
      let stopped = stopAt === 'before_read';
      const originalFrom = db.from.bind(db);
      db.from = (table) => {
        if (stopAt === 'during_eligibility' && table === 've_contact_supply_batches') stopped = true;
        return originalFrom(table);
      };
      const probe = jest.fn(async () => { if (stopAt === 'during_probe') stopped = true; return fundedProbe(); });
      expect((await resumeVeRequestyBillingJobs(db as unknown as SupabaseClient,
        { probe, keyFingerprint: BILLING_KEY, shouldStop: () => stopped })).resumed).toBe(0);
      expect(db.mutations).toEqual([]);
      if (stopAt === 'before_read') expect(probe).not.toHaveBeenCalled();
    }
    for (const stopAt of ['before_read', 'during_probe', 'after_first_resume'] as const) {
      let stopped = stopAt === 'before_read';
      const legacy = withAbortableRpc(createMockSupabase({ tables: {
        ve_contact_supply_plans: [legacyBillingPlan('first'), legacyBillingPlan('second')],
      }, rpcHandlers: { ve_resume_legacy_requesty_supply: () => {
        if (stopAt === 'after_first_resume') stopped = true;
        return { data: { resumed: true, reason: 'resumed' } };
      } } }));
      const probe = jest.fn(async () => { if (stopAt === 'during_probe') stopped = true; return fundedProbe(); });
      expect((await resumeVeRequestyBillingJobs(legacy as unknown as SupabaseClient,
        { now: new Date(NOW + 60_000), probe, keyFingerprint: BILLING_KEY, shouldStop: () => stopped })).resumed)
        .toBe(stopAt === 'after_first_resume' ? 1 : 0);
      expect(legacy.rpcCalls).toHaveLength(stopAt === 'after_first_resume' ? 1 : 0);
      expect(legacy.mutations).toEqual([]);
      if (stopAt === 'before_read') expect(probe).not.toHaveBeenCalled();
    }
  });

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

  it('retries only the saved queue transition and respects cancellation, ownership and a lost response', async () => {
    jest.useFakeTimers();
    try {
      for (const mode of ['gateway', 'lost-response', 'lost-response-read', 'cancelled', 'new-owner', 'aborted', 'backoff-cancel', 'deadline', 'permanent', 'outage'] as const) {
        jest.setSystemTime(NOW);
        const original = { id: 'saved-job', project_id: 'p', stage: 'base_collect', status: 'running',
          started_at: new Date(NOW).toISOString(), attempts: 3, payload: { base_id: 'b', ready_target: 500 },
          result: { paid_result: 'already saved' } } as unknown as VeJob;
        const db = createMockSupabase({ tables: { ve_jobs: [{ ...original }] }, beforeFirstUpdates: {
          ve_jobs: rows => rows.map(row => mode === 'cancelled' ? { ...row, status: 'cancelled' }
            : mode === 'new-owner' ? { ...row, started_at: new Date(NOW + 1_000).toISOString() } : row),
        } });
        const from = db.from.bind(db), patches: unknown[] = [];
        let reads = 0;
        const abort = new AbortController();
        db.from = table => {
          const builder = from(table);
          if (table !== 've_jobs') return builder;
          const update = builder.update.bind(builder), single = builder.maybeSingle.bind(builder);
          // The generic fixture's maybeSingle infers only successful responses;
          // this transport adapter also exercises real PostgREST error replies.
          const failed = (message: string, code?: string) => ({ data: null,
            error: { message, ...(code ? { code } : {}) } }) as unknown as Awaited<ReturnType<typeof single>>;
          let writing = false;
          builder.update = patch => { writing = true; patches.push(patch); return update(patch); };
          builder.maybeSingle = async () => {
            if (writing && mode === 'aborted') abort.abort(new Error('specialist paused'));
            if (writing && (mode === 'outage' || (['gateway', 'backoff-cancel'].includes(mode) && patches.length === 1))) {
              return failed('An invalid response was received from the upstream server');
            }
            if (writing && mode === 'deadline' && patches.length === 1) {
              return failed('TimeoutError: The operation was aborted due to timeout');
            }
            if (writing && mode === 'permanent') return failed('permission denied', '42501');
            if (mode === 'lost-response-read') {
              if (!writing && ++reads === 1) return failed('fetch failed');
              if (writing && patches.length > 1) return failed('VE_JOB_LEASE_LOST');
            }
            const saved = await single();
            if (writing && ['lost-response', 'lost-response-read'].includes(mode)) return failed('The upstream server is currently unavailable');
            return saved;
          };
          return builder;
        };
        const timeout = mode === 'deadline' ? jest.spyOn(AbortSignal, 'timeout').mockImplementationOnce(() => {
          const deadline = new AbortController(); deadline.abort(new DOMException('request deadline', 'TimeoutError')); return deadline.signal;
        }) : null;
        const paidWork = jest.fn().mockResolvedValue(undefined);
        const pending = (async () => { await paidWork(); await requeueVeJob({ supabase: db as unknown as SupabaseClient,
          signal: abort.signal }, original, 30_000); })().then(() => null, (error: Error) => error);
        if (mode === 'backoff-cancel') setTimeout(() => abort.abort(new Error('specialist paused')), 100);
        await jest.advanceTimersByTimeAsync(60_000);
        const error = await pending;
        timeout?.mockRestore();
        expect(paidWork).toHaveBeenCalledTimes(1);
        expect(new Set(patches.map(patch => JSON.stringify(patch))).size).toBe(1);
        expect(db.getRows('ve_jobs')[0]).toMatchObject({ attempts: 3, payload: original.payload, result: original.result });
        if (mode === 'outage') {
          expect(error).toBeInstanceOf(VeJobQueuePersistenceError);
          expect(patches).toHaveLength(6);
          expect(planVeJobFailure(original, error, NOW)).toMatchObject({ status: 'pending', attempts: 3,
            retryable: true, interruption: { count: 1, free: true } });
        } else if (mode === 'permanent') { expect(error?.message).toContain('permission denied'); expect(patches).toHaveLength(1); }
        else if (mode === 'aborted' || mode === 'backoff-cancel') {
          expect(error?.message).toBe('specialist paused'); expect(patches).toHaveLength(1);
        }
        else {
          expect(error).toBeNull();
          expect(patches).toHaveLength(['gateway', 'deadline', 'lost-response-read'].includes(mode) ? 2 : 1);
          expect(db.getRows('ve_jobs')[0]).toMatchObject(mode === 'cancelled' ? { status: 'cancelled' }
            : mode === 'new-owner' ? { status: 'running', started_at: new Date(NOW + 1_000).toISOString() }
              : { status: 'pending', started_at: null, run_after: new Date(NOW + 30_000).toISOString() });
        }
      }
    } finally { jest.useRealTimers(); }
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

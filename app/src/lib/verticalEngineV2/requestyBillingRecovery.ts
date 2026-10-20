import type { SupabaseClient } from '@supabase/supabase-js';
import type { VeJob } from './types';
import type { VeJobFailurePlan } from './jobRetry';
import { getVeRequestyApiKey, readVeRequestyBalance, veRequestyKeyFingerprint,
  type VeRequestyBalanceResult, type VeRequestyCreditSignal } from './requestyBalance';

/** A real response from this invocation's inference key, not a child parser's
 * error string or an old job whose credentials cannot be identified. */
export class VeRequestyBillingError extends Error {
  constructor(message: string, readonly keyFingerprint: string) {
    super(message);
    this.name = 'VeRequestyBillingError';
  }
}

// Existing cancellation/coordination understands pending. The explicit queue
// filter also protects waits against a changed run_after or clock.
export const VE_REQUESTY_BILLING_RUN_AFTER = '9999-12-31T00:00:00.000Z';
export const VE_REQUESTY_BILLING_INTERVAL_MS = 5 * 60_000;
const MAX_RESUMES_PER_SWEEP = 4;
const MAX_LEGACY_SCANS = 100;
const MAX_LEGACY_ATTEMPTS = 20;
// A bad historical checkpoint must not keep all newer failures behind it.
// The cursor only limits reads; all permission/state checks remain in the RPC.
const legacySupplyCursors = new WeakMap<SupabaseClient, string>();

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
function credit(value: unknown): VeRequestyCreditSignal | null {
  const row = record(value);
  return row && ['balanceUsd', 'monthlySpendUsd', 'monthlyLimitUsd']
    .every((key) => typeof row[key] === 'number' && Number.isFinite(row[key]) && (row[key] as number) >= 0)
    ? row as unknown as VeRequestyCreditSignal : null;
}

export function planVeRequestyBillingWait(job: Pick<VeJob, 'payload' | 'attempts'>,
  error: unknown, nowMs: number): VeJobFailurePlan | null {
  if (!(error instanceof VeRequestyBillingError) || !/^[a-f0-9]{64}$/.test(error.keyFingerprint)) return null;
  const recovery = record(job.payload.requesty_billing_recovery);
  const lastCredit = recovery?.key_fingerprint === error.keyFingerprint
    ? credit(recovery.credit_signal) : null;
  return { status: 'pending', attempts: job.attempts, attemptCap: job.attempts,
    retryable: false, interruption: null, runAfter: VE_REQUESTY_BILLING_RUN_AFTER,
    payload: { ...job.payload, requesty_billing_wait: { version: 1,
      key_fingerprint: error.keyFingerprint, blocked_at: new Date(nowMs).toISOString(),
      ...(lastCredit ? { last_credit: lastCredit } : {}) } } };
}

/** Spending credit is not a reason to replay an operation rejected with402. */
export function veRequestyCreditImproved(previous: VeRequestyCreditSignal | null, next: VeRequestyCreditSignal): boolean {
  if (!previous) return true; // One bounded attempt if top-up preceded the first check.
  return next.balanceUsd > previous.balanceUsd + 0.000001
    || (previous.monthlyLimitUsd > 0 && (next.monthlyLimitUsd === 0
      || next.monthlyLimitUsd > previous.monthlyLimitUsd
      || next.monthlySpendUsd < previous.monthlySpendUsd - 0.000001));
}

type WaitingJob = Pick<VeJob, 'id' | 'project_id' | 'stage' | 'payload' | 'updated_at'>;
type LegacySupply = { id: string; updated_at: string; last_error: string | null };
// Historical rows lack typed provider provenance. Accept only the old direct
// Requesty HTTP402 form, not "Requesty timeout; Serper402" or a child summary.
const isLegacySupplyBillingError = (value: unknown): boolean => typeof value === 'string'
  && /^\s*Requesty\s*(?:HTTP\s*)?[:(]?\s*402\b/i.test(value)
  && !/\b(?:Serper|OpenRouter|Polza)\b/i.test(value);

async function legacySupplyPage(db: SupabaseClient): Promise<LegacySupply[]> {
  const read = async (after?: string) => {
    let query = db.from('ve_contact_supply_plans').select('id,updated_at,last_error')
      .eq('status', 'error').not('item_id', 'is', null)
      .order('id', { ascending: true }).limit(MAX_LEGACY_SCANS);
    if (after) query = query.gt('id', after);
    const result = await query.abortSignal(AbortSignal.timeout(10_000));
    if (result.error) throw new Error('Requesty recovery historical supply read failed');
    return (result.data ?? []) as LegacySupply[];
  };
  const cursor = legacySupplyCursors.get(db);
  let page = await read(cursor);
  if (!page.length && cursor) {
    legacySupplyCursors.delete(db);
    page = await read();
  }
  return page;
}

/** Read-only eligibility. The final CAS fences cancellation; stages recheck
 * supply authorization before paid work. Never activate a paused plan here. */
async function canResume(db: SupabaseClient, job: WaitingJob, execution = false, now = new Date()): Promise<boolean> {
  const baseId = typeof job.payload.base_id === 'string' ? job.payload.base_id : null;
  const legacyRecovery = record(job.payload.requesty_billing_recovery)?.source === 'legacy_supply';
  if (legacyRecovery && (!baseId || job.payload.collection_mode !== 'supply'
    || typeof job.payload.supply_batch_id !== 'string')) return false;
  if (baseId) {
    const base = await db.from('ve_bases').select('id,status,project_id,hypothesis_id')
      .eq('id', baseId).eq('project_id', job.project_id).abortSignal(AbortSignal.timeout(10_000)).maybeSingle();
    if (base.error) throw new Error('Requesty recovery base read failed');
    const finishedCollection = execution && job.stage === 'base_collect'
      && ['analyzing', 'analyzed'].includes(base.data?.status ?? '');
    if (!base.data || base.data.status === 'failed'
      || (!execution && ((job.stage === 'base_collect' && base.data.status !== 'collecting')
        || (job.stage === 'base_analyze' && base.data.status !== 'analyzing')))) return false;
    const preparations = await db.from('ve_outreach_preparations').select('paused_at,cancelled_at')
      .eq('project_id', job.project_id).eq('base_id', baseId).abortSignal(AbortSignal.timeout(10_000));
    if (preparations.error) throw new Error('Requesty recovery preparation read failed');
    if (preparations.data?.some((p) => p.paused_at || p.cancelled_at)) return false;
    // Batch identity is found by base as well: not every stage payload carries it.
    const batch = await db.from('ve_contact_supply_batches').select('id,plan_id,status')
      .eq('base_id', baseId).abortSignal(AbortSignal.timeout(10_000)).maybeSingle();
    if (batch.error) throw new Error('Requesty recovery supply batch read failed');
    if (legacyRecovery && (!batch.data || batch.data.id !== job.payload.supply_batch_id)) return false;
    if (batch.data) {
      if (!finishedCollection && !['collecting', 'auditing'].includes(batch.data.status)) return false;
      const plan = await db.from('ve_contact_supply_plans').select('status,item_id,hypothesis_id')
        .eq('id', batch.data.plan_id).eq('project_id', job.project_id)
        .abortSignal(AbortSignal.timeout(10_000)).maybeSingle();
      if (plan.error) throw new Error('Requesty recovery supply plan read failed');
      if (plan.data?.status !== 'active') return false;
      if (legacyRecovery && (!base.data.hypothesis_id || base.data.hypothesis_id !== plan.data.hypothesis_id)) return false;
      if (execution && !finishedCollection) {
        if (legacyRecovery) {
          // The resumed source base differs from the initial preview: a later
          // specialist pause must be checked at hypothesis scope as well.
          if (!plan.data.item_id || !plan.data.hypothesis_id) return false;
          const preparation = await db.from('ve_outreach_preparations').select('paused_at,cancelled_at')
            .eq('project_id', job.project_id).eq('hypothesis_id', plan.data.hypothesis_id)
            .abortSignal(AbortSignal.timeout(10_000));
          if (preparation.error) throw new Error('Requesty recovery preparation scope read failed');
          if (preparation.data?.some((row) => row.paused_at || row.cancelled_at)) return false;
          const campaigns = await db.from('ve_launch_queue_campaigns').select('id')
            .eq('item_id', plan.data.item_id).in('remote_status', [1, 3, 4])
            .gte('status_observed_at', new Date(now.getTime() - 5 * 60_000).toISOString())
            .lte('status_observed_at', new Date(now.getTime() + 60_000).toISOString())
            .limit(1).abortSignal(AbortSignal.timeout(10_000)).maybeSingle();
          if (campaigns.error) throw new Error('Requesty recovery campaign state read failed');
          if (!campaigns.data) return false;
        }
        // Analysis has no native supply hold. Use the same eligibility rule as
        // collection/auditing, including approval freshness and campaign pause.
        const eligibility = await db.rpc('ve_require_contact_supply_active', {
          p_plan_id: batch.data.plan_id, p_now: now.toISOString(),
        }).abortSignal(AbortSignal.timeout(10_000));
        if (eligibility.error) {
          if (/^(supply plan is not active|supply approval rules are stale|supply requires active campaign)/.test(eligibility.error.message)) return false;
          throw new Error('Requesty recovery supply eligibility read failed');
        }
      }
    }
  }
  return true;
}

/** Credit can be confirmed before a worker slot becomes available. Recheck
 * specialist controls at execution time without probing or purchasing work. */
export async function deferVeRequestyRecoveryWhileIneligible(db: SupabaseClient, job: VeJob, options: {
  now?: Date; signal?: AbortSignal;
  onUnreadableEligibility?: () => void;
} = {}): Promise<boolean> {
  const recovery = record(job.payload.requesty_billing_recovery);
  if (recovery?.version !== 1) return false;
  const now = options.now ?? new Date();
  options.signal?.throwIfAborted();
  try {
    if (await canResume(db, job, true, now)) return false;
  } catch {
    options.signal?.throwIfAborted();
    // Unknown permission/availability is not permission to spend. Retain the
    // same paid work and retry the read, without consuming stage attempts.
    options.onUnreadableEligibility?.();
  }
  options.signal?.throwIfAborted();
  let update = db.from('ve_jobs').update({ status: 'pending', started_at: null,
    run_after: new Date(now.getTime() + VE_REQUESTY_BILLING_INTERVAL_MS).toISOString(), updated_at: now.toISOString() })
    .eq('id', job.id).eq('status', 'running');
  update = job.started_at === null ? update.is('started_at', null) : update.eq('started_at', job.started_at);
  const saved = await update.select('id').abortSignal(AbortSignal.timeout(10_000)).maybeSingle();
  if (saved.error) throw new Error(`Requesty recovery execution guard save: ${saved.error.message}`);
  // A lost claim or cancellation must also skip the old invocation's work.
  return true;
}

/** No work is purchased by the probe. One confirmed credit signal releases
 * existing waits or atomically repairs eligible historical supply failures.
 * Both paths share the same cap; no new jobs/bases or round allowances. */
export async function resumeVeRequestyBillingJobs(db: SupabaseClient, options: {
  now?: Date;
  shouldStop?: () => boolean;
  probe?: () => Promise<VeRequestyBalanceResult>;
  keyFingerprint?: string;
} = {}): Promise<{ waiting: number; resumed: number; reason: string }> {
  const shouldStop = options.shouldStop ?? (() => false);
  let keyFingerprint = options.keyFingerprint;
  if (!keyFingerprint) {
    try { keyFingerprint = veRequestyKeyFingerprint(getVeRequestyApiKey()); }
    catch { return { waiting: 0, resumed: 0, reason: 'missing_api_key' }; }
  }
  if (shouldStop()) return { waiting: 0, resumed: 0, reason: 'shutdown' };
  // Pagination reads only small lifecycle/payload fields, never saved contacts
  // or paid result checkpoints. Read before writes so offsets remain stable.
  const jobs: WaitingJob[] = [];
  for (let offset = 0; !shouldStop(); offset += 100) {
    const result = await db.from('ve_jobs').select('id,project_id,stage,payload,updated_at')
      .eq('status', 'pending').eq('payload->requesty_billing_wait->>version', '1')
      .eq('payload->requesty_billing_wait->>key_fingerprint', keyFingerprint)
      .order('updated_at', { ascending: true }).order('id', { ascending: true })
      .abortSignal(AbortSignal.timeout(10_000)).range(offset, offset + 99);
    if (result.error) throw new Error('Requesty recovery queue read failed');
    jobs.push(...(result.data ?? []) as WaitingJob[]);
    if (!result.data || result.data.length < 100) break;
  }
  if (shouldStop()) return { waiting: jobs.length, resumed: 0, reason: 'shutdown' };
  const legacyPage = await legacySupplyPage(db);
  const legacy = legacyPage.filter((plan) => isLegacySupplyBillingError(plan.last_error));
  const waiting = jobs.length + legacy.length;
  if (!waiting) {
    if (legacyPage.length) legacySupplyCursors.set(db, legacyPage[legacyPage.length - 1].id);
    return { waiting: 0, resumed: 0, reason: 'no_work' };
  }
  if (shouldStop()) return { waiting, resumed: 0, reason: 'shutdown' };
  const probe = await (options.probe ?? readVeRequestyBalance)();
  if (probe.keyFingerprint !== keyFingerprint) return { waiting, resumed: 0, reason: 'key_mismatch' };
  const now = (options.now ?? new Date()).toISOString();
  let resumed = 0;
  for (const job of jobs) {
    if (shouldStop()) break;
    const wait = record(job.payload.requesty_billing_wait);
    if (!wait || typeof wait.blocked_at !== 'string' || !Number.isFinite(Date.parse(wait.blocked_at))) continue;
    // Corrupt state is not an initial incident and cannot authorize a paid retry.
    if (wait.last_credit != null && !credit(wait.last_credit)) continue;
    const release = probe.status === 'usable' && resumed < MAX_RESUMES_PER_SWEEP
      && veRequestyCreditImproved(credit(wait.last_credit), probe.creditSignal)
      && await canResume(db, job);
    // When the release cap or a specialist pause holds a job, retain its old
    // baseline so it can use the same confirmed top-up on a later sweep.
    const state = probe.status === 'usable' ? { probe_status: 'blocked', probe_reason: 'awaiting_credit_change' }
      : { probe_status: probe.status, probe_reason: probe.reason };
    const nextWait = { ...wait, ...state,
      ...(probe.status === 'blocked' ? { last_credit: probe.creditSignal } : {}) };
    if (probe.status === 'usable' && !veRequestyCreditImproved(credit(wait.last_credit), probe.creditSignal)) {
      nextWait.last_credit = probe.creditSignal;
    }
    const payload = release ? { ...job.payload, requesty_billing_wait: null, requesty_billing_recovery: {
      version: 1, key_fingerprint: keyFingerprint, credit_signal: probe.status === 'usable' ? probe.creditSignal : null,
      blocked_at: wait.blocked_at, resumed_at: now,
      ...(record(job.payload.requesty_billing_recovery)?.source === 'legacy_supply'
        ? { source: 'legacy_supply' } : {}),
    } } : { ...job.payload, requesty_billing_wait: nextWait };
    if (shouldStop()) break;
    if (!release && JSON.stringify(wait) === JSON.stringify(nextWait)) continue;
    const write = await db.from('ve_jobs').update({ payload, updated_at: now,
      ...(release ? { run_after: now, error: null, finished_at: null } : {}) })
      .eq('id', job.id).eq('status', 'pending').eq('updated_at', job.updated_at)
      .eq('payload->requesty_billing_wait->>blocked_at', wait.blocked_at)
      .eq('payload->requesty_billing_wait->>key_fingerprint', keyFingerprint)
      .select('id').abortSignal(AbortSignal.timeout(10_000)).maybeSingle();
    if (write.error) throw new Error('Requesty recovery queue save failed');
    if (release && write.data) resumed += 1;
  }
  if (probe.status === 'usable') {
    let attempted = 0;
    for (const plan of legacyPage) {
      if (shouldStop() || resumed >= MAX_RESUMES_PER_SWEEP || attempted >= MAX_LEGACY_ATTEMPTS) break;
      legacySupplyCursors.set(db, plan.id);
      if (!isLegacySupplyBillingError(plan.last_error)) continue;
      attempted += 1;
      // The transaction checks the latest batch/base/job, specialist controls,
      // previous credit baseline and the exact saved budget before any write.
      const result = await db.rpc('ve_resume_legacy_requesty_supply', {
        p_plan_id: plan.id, p_expected_updated_at: plan.updated_at,
        p_key_fingerprint: keyFingerprint, p_credit_signal: probe.creditSignal,
        p_credit_observed_at: now, p_now: (options.now ?? new Date()).toISOString(),
      }).abortSignal(AbortSignal.timeout(10_000));
      const outcome = record(result.data);
      // An uncertain commit consumes the rest of this sweep: continuing could
      // exceed the shared release cap after an RPC response was lost.
      if (result.error || typeof outcome?.resumed !== 'boolean') {
        throw new Error('Requesty recovery historical supply result unconfirmed');
      }
      if (outcome.resumed) resumed += 1;
    }
  }
  return { waiting, resumed, reason: probe.reason };
}

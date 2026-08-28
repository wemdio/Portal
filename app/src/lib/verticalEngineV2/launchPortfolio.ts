/**
 * Pure launch-portfolio rules for the internal Vertical Engine v2.
 *
 * A portfolio bundle is one business launch unit. Segmentation may materialize
 * several Instantly campaigns, but they reserve capacity together against the
 * immutable workspace + mailbox snapshot captured at prepare time.
 */

import { CampaignStatus, type CampaignStatusValue } from '@/lib/instantly/types';

export type VeLaunchPortfolioStatus =
  | 'prepared'
  | 'queued'
  | 'activating'
  | 'active'
  | 'uncertain'
  | 'released'
  | 'skipped'
  | 'cancelled';

export type VeSeasonalityConfidence = 'low' | 'medium' | 'high';

export interface VeLaunchPortfolioCampaign {
  campaign_id: string;
  status: CampaignStatusValue | number | null;
  status_observed_at: string | null;
}

export interface VeLaunchPortfolioBundle {
  id: string;
  instantly_account_id: string;
  mailbox_ids: string[];
  status: VeLaunchPortfolioStatus;
  campaigns: VeLaunchPortfolioCampaign[];
  ever_active_at: string | null;
  manual_order: number | null;
  latest_activation_at: string | null;
  seasonality_confidence: VeSeasonalityConfidence | null;
  potential_pct: number;
  created_at: string;
}

export interface VeLaunchCapacityEvaluation {
  allowed: boolean;
  required_slots: 1;
  occupied_slots: number;
  blocking_bundle_ids: string[];
  /** Capacity admission is deliberately non-preemptive. */
  preempted_bundle_ids: [];
  code: 'OK' | 'INVALID_CAPACITY' | 'MAILBOX_SCOPE_REQUIRED' | 'SLOT_OCCUPIED';
}

export interface VeLaunchCapacityBundleScope {
  id: string;
  instantly_account_id: string;
  mailbox_ids: unknown;
  status: VeLaunchPortfolioStatus;
}

const SLOT_HOLDER_STATUSES = new Set<VeLaunchPortfolioStatus>([
  'activating',
  'active',
  'uncertain',
]);
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Convert an exclusive peak-completion deadline into the last safe start day.
 * Moscow is UTC+3 year-round, so keeping the calendar arithmetic in UTC and
 * adding the explicit offset avoids host-timezone and DST drift.
 */
export function latestSeasonalActivationAt(input: {
  seasonal_deadline_date: string | null | undefined;
  estimated_run_days: number | null | undefined;
}): string | null {
  const deadline = input.seasonal_deadline_date;
  if (!deadline || !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return null;
  const deadlineMs = Date.parse(`${deadline}T00:00:00.000Z`);
  if (
    !Number.isFinite(deadlineMs) ||
    new Date(deadlineMs).toISOString().slice(0, 10) !== deadline ||
    typeof input.estimated_run_days !== 'number' ||
    !Number.isFinite(input.estimated_run_days) ||
    input.estimated_run_days <= 0
  ) {
    return null;
  }
  const latestMs = deadlineMs - Math.ceil(input.estimated_run_days) * DAY_MS;
  return `${new Date(latestMs).toISOString().slice(0, 10)}T00:00:00+03:00`;
}

export function normalizeLaunchMailboxIds(mailboxIds: unknown): string[] {
  if (!Array.isArray(mailboxIds)) return [];
  return [...new Set(
    mailboxIds
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim().toLocaleLowerCase('en-US'))
      .filter((value) => value.length > 0),
  )].sort((left, right) => left.localeCompare(right, 'en'));
}

export function launchMailboxScopesEqual(leftIds: unknown, rightIds: unknown): boolean {
  if (
    !Array.isArray(leftIds)
    || !Array.isArray(rightIds)
    || leftIds.some((value) => typeof value !== 'string' || value.trim().length === 0)
    || rightIds.some((value) => typeof value !== 'string' || value.trim().length === 0)
  ) {
    return false;
  }
  const left = normalizeLaunchMailboxIds(leftIds);
  const right = normalizeLaunchMailboxIds(rightIds);
  return left.length > 0
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function launchMailboxScopesOverlap(
  leftIds: unknown,
  rightIds: unknown,
): boolean {
  const left = new Set(normalizeLaunchMailboxIds(leftIds));
  const right = new Set(normalizeLaunchMailboxIds(rightIds));
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  for (const value of smaller) {
    if (larger.has(value)) return true;
  }
  return false;
}

/**
 * Evaluate capacity without mutating or preempting an existing holder.
 * `max_active_bundles` applies only to bundles sharing at least one mailbox in
 * the same Instantly workspace; disjoint pools can operate independently.
 */
export function evaluateLaunchCapacity<T extends VeLaunchCapacityBundleScope>(input: {
  candidate: T;
  holders: readonly T[];
  max_active_bundles: number;
}): VeLaunchCapacityEvaluation {
  const limit = input.max_active_bundles;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    return {
      allowed: false,
      required_slots: 1,
      occupied_slots: 0,
      blocking_bundle_ids: [],
      preempted_bundle_ids: [],
      code: 'INVALID_CAPACITY',
    };
  }

  const candidateAccount = input.candidate.instantly_account_id.trim();
  const candidateMailboxes = normalizeLaunchMailboxIds(input.candidate.mailbox_ids);
  if (!candidateAccount || candidateMailboxes.length === 0) {
    return {
      allowed: false,
      required_slots: 1,
      occupied_slots: 0,
      blocking_bundle_ids: [],
      preempted_bundle_ids: [],
      code: 'MAILBOX_SCOPE_REQUIRED',
    };
  }

  const blockingIds: string[] = [];
  const seen = new Set<string>();
  for (const holder of input.holders) {
    if (holder.id === input.candidate.id || seen.has(holder.id)) continue;
    if (!SLOT_HOLDER_STATUSES.has(holder.status)) continue;
    if (holder.instantly_account_id.trim() !== candidateAccount) continue;
    if (!launchMailboxScopesOverlap(candidateMailboxes, holder.mailbox_ids)) continue;
    seen.add(holder.id);
    blockingIds.push(holder.id);
  }
  blockingIds.sort((a, b) => a.localeCompare(b, 'en'));

  const occupied = blockingIds.length;
  const allowed = occupied + 1 <= limit;
  return {
    allowed,
    required_slots: 1,
    occupied_slots: occupied,
    blocking_bundle_ids: allowed ? [] : blockingIds,
    preempted_bundle_ids: [],
    code: allowed ? 'OK' : 'SLOT_OCCUPIED',
  };
}

interface VeRankableLaunchQueueItem {
  id: string;
  manual_order: number | null;
  latest_activation_at: string | null;
  seasonality_confidence: VeSeasonalityConfidence | null;
  potential_pct: number;
  created_at: string;
}

export type VeLaunchPortfolioMode = 'advisory' | 'enforced';

export interface VeLaunchActivationQueueItem extends VeRankableLaunchQueueItem {
  instantly_account_id: unknown;
  mailbox_ids: unknown;
  status: unknown;
  not_before: unknown;
  priority_snapshot: unknown;
  priority_override_decision: unknown;
  priority_override_reason: unknown;
  priority_overridden_by: unknown;
  priority_overridden_at: unknown;
}

export interface VeLaunchActivationHeadMark {
  activation_admissible: boolean;
  is_activation_head: boolean;
  activation_head_id: string | null;
}

const CONFIDENCE_RANK: Record<VeSeasonalityConfidence, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

function finiteNumber(value: number | null | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function parsedTime(value: string | null | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Stable portfolio order: explicit manual order, seasonal urgency, confidence,
 * potential, starvation age, then id. The function returns a copy and never
 * mutates the caller's queue.
 */
export function rankLaunchQueue<T extends VeRankableLaunchQueueItem>(
  rows: readonly T[],
  options: { as_of: string },
): T[] {
  const asOfMs = Date.parse(options.as_of);
  if (!Number.isFinite(asOfMs)) throw new RangeError('as_of must be a valid timestamp');

  const manualRank = (row: T): [number, number] => {
    const value = finiteNumber(row.manual_order, Number.POSITIVE_INFINITY);
    return Number.isFinite(value) ? [0, value] : [1, Number.POSITIVE_INFINITY];
  };
  const seasonalUrgency = (row: T): number =>
    parsedTime(row.latest_activation_at, Number.POSITIVE_INFINITY) - asOfMs;
  const confidence = (row: T): number =>
    row.seasonality_confidence ? CONFIDENCE_RANK[row.seasonality_confidence] : 0;

  return [...rows].sort((left, right) => {
    const [leftManualBucket, leftManualOrder] = manualRank(left);
    const [rightManualBucket, rightManualOrder] = manualRank(right);
    return (
      leftManualBucket - rightManualBucket ||
      leftManualOrder - rightManualOrder ||
      seasonalUrgency(left) - seasonalUrgency(right) ||
      confidence(right) - confidence(left) ||
      finiteNumber(right.potential_pct, 0) - finiteNumber(left.potential_pct, 0) ||
      parsedTime(left.created_at, Number.POSITIVE_INFINITY) -
        parsedTime(right.created_at, Number.POSITIVE_INFINITY) ||
      left.id.localeCompare(right.id, 'en')
    );
  });
}

function hasAuditedPriorityDecision(
  row: VeLaunchActivationQueueItem,
  decision: 'activate_next' | 'wait',
): boolean {
  return row.priority_override_decision === decision
    && typeof row.priority_override_reason === 'string'
    && row.priority_override_reason.trim().length > 0
    && typeof row.priority_overridden_by === 'string'
    && row.priority_overridden_by.trim().length > 0
    && typeof row.priority_overridden_at === 'string'
    && Number.isFinite(Date.parse(row.priority_overridden_at));
}

function automaticActivationEligible(prioritySnapshot: unknown): boolean {
  return prioritySnapshot != null
    && typeof prioritySnapshot === 'object'
    && !Array.isArray(prioritySnapshot)
    && (prioritySnapshot as Record<string, unknown>).automatic_activation_eligible === true;
}

function admissibleActivationScope(
  row: VeLaunchActivationQueueItem,
  input: { asOfMs: number; mode: VeLaunchPortfolioMode },
): { workspace: string; mailboxes: string[] } | null {
  if (row.status !== 'queued') return null;
  if (typeof row.instantly_account_id !== 'string' || !row.instantly_account_id.trim()) {
    return null;
  }
  const mailboxes = normalizeLaunchMailboxIds(row.mailbox_ids);
  if (mailboxes.length === 0) return null;

  if (row.not_before !== null) {
    if (typeof row.not_before !== 'string') return null;
    const notBeforeMs = Date.parse(row.not_before);
    if (!Number.isFinite(notBeforeMs) || notBeforeMs > input.asOfMs) return null;
  }
  if (hasAuditedPriorityDecision(row, 'wait')) return null;
  if (
    input.mode === 'enforced'
    && !automaticActivationEligible(row.priority_snapshot)
    && !hasAuditedPriorityDecision(row, 'activate_next')
  ) {
    return null;
  }

  return { workspace: row.instantly_account_id, mailboxes };
}

/**
 * Mirror the activation RPC's admission and head-selection contract for the
 * read API. A queue can have multiple heads when mailbox pools are disjoint;
 * an admissible lower-ranked item points at the first ranked item that shares
 * at least one mailbox in the exact Instantly workspace.
 */
export function evaluateLaunchActivationHeads<T extends VeLaunchActivationQueueItem>(
  rows: readonly T[],
  options: { as_of: string; mode: VeLaunchPortfolioMode },
): { ranked: T[]; marks: ReadonlyMap<string, VeLaunchActivationHeadMark> } {
  const ranked = rankLaunchQueue(rows, { as_of: options.as_of });
  const asOfMs = Date.parse(options.as_of);
  const candidates: Array<{
    row: T;
    rank: number;
    workspace: string;
    mailboxes: string[];
  }> = [];
  const scopeById = new Map<string, { workspace: string; mailboxes: string[] }>();

  ranked.forEach((row, rank) => {
    const scope = admissibleActivationScope(row, { asOfMs, mode: options.mode });
    if (!scope) return;
    candidates.push({ row, rank, ...scope });
    scopeById.set(row.id, scope);
  });

  const firstByWorkspaceMailbox = new Map<string, Map<string, typeof candidates[number]>>();
  for (const candidate of candidates) {
    const firstByMailbox = firstByWorkspaceMailbox.get(candidate.workspace) ?? new Map();
    for (const mailbox of candidate.mailboxes) {
      if (!firstByMailbox.has(mailbox)) firstByMailbox.set(mailbox, candidate);
    }
    firstByWorkspaceMailbox.set(candidate.workspace, firstByMailbox);
  }

  const marks = new Map<string, VeLaunchActivationHeadMark>();
  for (const row of ranked) {
    const scope = scopeById.get(row.id);
    if (!scope) {
      marks.set(row.id, {
        activation_admissible: false,
        is_activation_head: false,
        activation_head_id: null,
      });
      continue;
    }

    const firstByMailbox = firstByWorkspaceMailbox.get(scope.workspace);
    let head: typeof candidates[number] | null = null;
    for (const mailbox of scope.mailboxes) {
      const candidate = firstByMailbox?.get(mailbox);
      if (candidate && (head === null || candidate.rank < head.rank)) head = candidate;
    }
    const headId = head?.row.id ?? null;
    marks.set(row.id, {
      activation_admissible: true,
      is_activation_head: headId === row.id,
      activation_head_id: headId,
    });
  }

  return { ranked, marks };
}

export interface VeLaunchReleaseEvaluation {
  auto_release: boolean;
  holds_slot: boolean;
  next_status: VeLaunchPortfolioStatus;
  reason_codes: Array<
    | 'NO_CAMPAIGNS'
    | 'LIVE_PROOF_REQUIRED'
    | 'LIVE_PROOF_STALE'
    | 'CAMPAIGN_NOT_COMPLETED'
  >;
}

interface ReleaseOptions {
  now: string;
  max_observation_age_ms: number;
}

function releaseClock(options: ReleaseOptions): { nowMs: number; maxAgeMs: number } {
  const nowMs = Date.parse(options.now);
  if (!Number.isFinite(nowMs)) throw new RangeError('now must be a valid timestamp');
  if (!Number.isFinite(options.max_observation_age_ms) || options.max_observation_age_ms < 0) {
    throw new RangeError('max_observation_age_ms must be non-negative');
  }
  return { nowMs, maxAgeMs: options.max_observation_age_ms };
}

function observationAge(
  campaign: Pick<VeLaunchPortfolioCampaign, 'status_observed_at'>,
  nowMs: number,
): number | null {
  if (!campaign.status_observed_at) return null;
  const observedMs = Date.parse(campaign.status_observed_at);
  if (!Number.isFinite(observedMs) || observedMs > nowMs) return null;
  return nowMs - observedMs;
}

/** Auto-release is deliberately stricter than "not currently active". */
export function evaluateLaunchBundleRelease<T extends VeLaunchPortfolioBundle>(
  bundle: T,
  options: ReleaseOptions,
): VeLaunchReleaseEvaluation {
  const { nowMs, maxAgeMs } = releaseClock(options);
  const reasons: VeLaunchReleaseEvaluation['reason_codes'] = [];

  if (bundle.campaigns.length === 0) reasons.push('NO_CAMPAIGNS');
  for (const campaign of bundle.campaigns) {
    const age = observationAge(campaign, nowMs);
    if (campaign.status == null || age == null) {
      reasons.push('LIVE_PROOF_REQUIRED');
      continue;
    }
    if (age > maxAgeMs) reasons.push('LIVE_PROOF_STALE');
    if (campaign.status !== CampaignStatus.Completed) reasons.push('CAMPAIGN_NOT_COMPLETED');
  }

  const uniqueReasons = [...new Set(reasons)];
  const autoRelease = bundle.campaigns.length > 0 && uniqueReasons.length === 0;
  const holdsBeforeRelease = SLOT_HOLDER_STATUSES.has(bundle.status);
  return {
    auto_release: autoRelease,
    holds_slot: autoRelease ? false : holdsBeforeRelease,
    next_status: autoRelease ? 'released' : bundle.status,
    reason_codes: uniqueReasons,
  };
}

export type VeManualLaunchReleaseCode =
  | 'OK'
  | 'REASON_REQUIRED'
  | 'BUNDLE_NOT_HOLDING_SLOT'
  | 'LIVE_PROOF_REQUIRED'
  | 'LIVE_PROOF_STALE'
  | 'CAMPAIGN_STILL_ACTIVE';

export interface VeManualLaunchReleaseValidation {
  ok: boolean;
  code: VeManualLaunchReleaseCode;
  reason: string | null;
}

const KNOWN_REMOTE_STATUSES = new Set<number>(Object.values(CampaignStatus));
const ACTIVELY_SENDING_STATUSES = new Set<number>([
  CampaignStatus.Active,
  CampaignStatus.RunningSubsequences,
]);

/**
 * Manual release permits a paused/degraded campaign only with a reason and a
 * fresh live observation. Unknown/missing statuses fail closed.
 */
export function validateManualLaunchRelease<T extends VeLaunchPortfolioBundle>(input: {
  bundle: T;
  reason: string;
  now: string;
  max_observation_age_ms: number;
}): VeManualLaunchReleaseValidation {
  const reason = input.reason.trim();
  if (!reason) return { ok: false, code: 'REASON_REQUIRED', reason: null };
  if (!SLOT_HOLDER_STATUSES.has(input.bundle.status)) {
    return { ok: false, code: 'BUNDLE_NOT_HOLDING_SLOT', reason: null };
  }

  const { nowMs, maxAgeMs } = releaseClock(input);
  if (input.bundle.campaigns.length === 0) {
    return { ok: false, code: 'LIVE_PROOF_REQUIRED', reason: null };
  }

  for (const campaign of input.bundle.campaigns) {
    const age = observationAge(campaign, nowMs);
    if (
      campaign.status == null ||
      !KNOWN_REMOTE_STATUSES.has(campaign.status) ||
      age == null
    ) {
      return { ok: false, code: 'LIVE_PROOF_REQUIRED', reason: null };
    }
    if (age > maxAgeMs) return { ok: false, code: 'LIVE_PROOF_STALE', reason: null };
    if (ACTIVELY_SENDING_STATUSES.has(campaign.status)) {
      return { ok: false, code: 'CAMPAIGN_STILL_ACTIVE', reason: null };
    }
  }

  return { ok: true, code: 'OK', reason };
}

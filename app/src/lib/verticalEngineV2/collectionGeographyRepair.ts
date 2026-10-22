import { createHash } from 'node:crypto';
import { countVeTargetContacts, normalizeVeMaxEmailsPerCompany } from './companyContactCap';
import { withVeTargetComposition } from './collectionTarget';
import { collectionRoundLimit } from './collectionTarget';
import { veSourceStrategyKey } from './adaptiveCollection';
import { applyVeCollectionGeographyToPlan, readVeCollectionGeography, type VeCollectionGeography } from './collectionGeography';
import type { VeCollectInfo, VeCollectTaskState } from './stages/baseCollect';

type Row = Record<string, unknown>;
type Job = { id: string; status: string; stage: string; payload: Row; result: Row | null;
  updated_at: string; started_at: string | null; finished_at: string | null };
export interface VeGeographyRepairSnapshot {
  project_id: string; setup_revision: number; selected: boolean;
  approved: boolean; frozen: boolean; accepted_launch: boolean;
  base: { id: string; project_id: string; hypothesis_id: string; source: string; status: string;
    data: Row[]; row_count: number; columns: string[]; updated_at: string;
    collect_info: VeCollectInfo; max_emails_per_company: number | null; analysis?: unknown };
  preparation: { base_id: string; hypothesis_id: string; status: string; updated_at: string;
    paused_at: string | null; cancelled_at: string | null; pause_state: Row | null;
    locked_until: string | null; claim_token: string | null; independent_control: boolean };
  jobs: Job[];
  children: Array<{ id: string; status: string; updated_at: string }>;
}

/** Stable JSON digest for a compare-and-swap receipt, not a replacement for DB locks. */
export function veGeographyRepairHash(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => [key, canonical(item)])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export interface VeGeographyRepairRequest {
  repair_id: string; required: VeCollectionGeography; reviewed_data_hash: string;
  /** Explicit reviewed membership; this planner never guesses geography from email/INN/name. */
  ready_row_indices: number[];
  /** Only the pause created by this repair may be adopted. A specialist's earlier pause is not permission. */
  owned_pause_at?: string;
  prepared_at: string;
}

export interface VeGeographyRepairReceipt {
  version: 1; repair_id: string; prepared_at: string; required: VeCollectionGeography;
  original_data_hash: string; original_collect_info_hash: string; kept_data_hash: string;
  reviewed_ready_indices: number[]; held_ready_rows: Row[];
  /** Non-ready buffers have no explicit geo approval. Preserve them outside automatic review. */
  held_candidate_buffers: Pick<VeCollectInfo, 'relevance_reserve' | 'search_policy' | 'project_exclusion_reserve'>;
  previous_tasks: VeCollectTaskState[]; retired_task_indices: number[];
  previous_construct?: VeCollectInfo['construct']; previous_estimate?: VeCollectInfo['estimate'];
  previous_adaptive_collection?: VeCollectInfo['adaptive_collection'];
  previous_analysis?: unknown;
  previous_restaurant_source_refresh?: VeCollectInfo['restaurant_source_refresh'];
  previous_audience_source_refresh?: VeCollectInfo['audience_source_refresh'];
  source_rewrites: Array<{ index: number; reason: 'fresh_pending' | 'free_scoped_cursor' }>;
  source_keys: string[];
  budget: { max_rounds: number; max_candidates: number; initial_round: number; initial_candidates: number };
  preserve_analysis: boolean; preparation_stale: true;
  continuation_job_id?: string; continuation_started_at?: string;
  /** A repair cannot renew paid acquisition, source replans, or collection limits. */
  resume_policy: 'explicit_bounded_only';
}

export type VeGeographyRepairInfo = VeCollectInfo & { geography_repair?: VeGeographyRepairReceipt };
export type VeGeographyRepairPlan = { status: 'blocked'; reasons: string[] } | {
  status: 'prepared' | 'already_prepared';
  expected: { project_id: string; setup_revision: number; base_id: string; base_updated_at: string;
    data_hash: string; collect_info_hash: string; preparation_hash: string; jobs_hash: string; children_hash: string };
  patch: { data: Row[]; row_count: number; sample_rows: Row[]; collect_info: VeGeographyRepairInfo; analysis: null };
  preserved_job_results: Array<{ id: string; result_hash: string }>;
  budget: { max_candidates: number; candidates_processed: number; candidates_remaining: number;
    max_rounds: number; round: number; rounds_remaining: number };
  continuation: { allowed: boolean; reasons: string[]; corrected_source_count: number };
};

const active = new Set(['pending', 'running', 'processing', 'queued']);
const rec = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};

/** Offline planner only: no persistence, enqueue, HTTP, models, or automatic resume.
 * The applier must recheck the receipt under the normal project -> job -> base locks.
 * The atomic applier separately opts into prepareVeGeographyRepairContinuation. */
export function planVeCollectionGeographyRepair(
  snapshot: VeGeographyRepairSnapshot, request: VeGeographyRepairRequest,
): VeGeographyRepairPlan {
  const { base, preparation: prep } = snapshot;
  const info: VeGeographyRepairInfo = base.collect_info;
  const reasons: string[] = [];
  let required: VeCollectionGeography | null = null;
  try { required = readVeCollectionGeography(request.required); } catch { reasons.push('invalid_geography'); }
  if (!required?.required) reasons.push('explicit_geography_required');
  if (!request.repair_id?.trim() || !Number.isFinite(Date.parse(request.prepared_at))) reasons.push('invalid_repair_identity');
  if (base.project_id !== snapshot.project_id || prep.base_id !== base.id
    || prep.hypothesis_id !== base.hypothesis_id) reasons.push('binding_changed');
  if (!Number.isSafeInteger(snapshot.setup_revision) || snapshot.setup_revision < 1) reasons.push('invalid_setup_revision');
  if (snapshot.approved !== false || snapshot.frozen !== false || snapshot.accepted_launch !== false) reasons.push('approved_or_launched');
  if (snapshot.selected !== true && prep.independent_control !== true) reasons.push('not_selected');
  if (base.source !== 'auto' || info.collection_mode !== 'preview' || info.supply_batch_id || info.refill) reasons.push('not_preview');
  if (!['analyzed', 'collecting'].includes(base.status)) reasons.push('unsupported_base_status');
  if (prep.claim_token || prep.locked_until) reasons.push('coordinator_lease_not_released');
  if (prep.paused_at) {
    if (request.owned_pause_at !== prep.paused_at || prep.cancelled_at !== prep.paused_at
      || rec(prep.pause_state).version !== 1) reasons.push('pause_not_owned');
  } else if (prep.cancelled_at || prep.status !== 'ready' || base.status !== 'analyzed') reasons.push('not_quiescent');
  if (snapshot.jobs.some((job) => active.has(job.status))) reasons.push('active_parent_job');
  if (snapshot.children.some((child) => active.has(child.status))) reasons.push('active_child_job');
  if (info.preview_pipeline?.batches.length || info.preview_pipeline?.active_batch_id
    || info.construct?.status === 'dispatched' || info.saved_email_recovery?.batch
    || info.adaptive_collection?.pending || info.company_name_recovery) reasons.push('saved_pipeline_not_drained');
  const referenced = new Set(info.preview_pipeline?.job_ids ?? []);
  if (info.construct?.bc_job_id) referenced.add(info.construct.bc_job_id);
  const children = new Set(snapshot.children.map((child) => child.id));
  if ([...referenced].some((id) => !children.has(id))) reasons.push('missing_saved_child');
  if (!Array.isArray(base.data) || base.row_count !== base.data.length) reasons.push('ready_count_changed');
  const target = info.target_progress;
  if (target && info.target_checkpoint?.completed_round !== target.round) reasons.push('saved_round_not_closed');
  if (!target || [target.max_candidates, target.candidates_processed, target.max_rounds, target.round]
    .some((n) => !Number.isSafeInteger(n) || n < 0)) reasons.push('invalid_saved_budget');
  const dataHash = veGeographyRepairHash(base.data);
  const previous = info.geography_repair;
  const repeated = previous?.repair_id === request.repair_id && previous.original_data_hash === request.reviewed_data_hash
    && previous.kept_data_hash === dataHash && veGeographyRepairHash(previous.required) === veGeographyRepairHash(required)
    && veGeographyRepairHash(previous.reviewed_ready_indices) === veGeographyRepairHash(request.ready_row_indices);
  if (previous && !repeated) reasons.push('repair_receipt_conflict');
  if (!repeated && dataHash !== request.reviewed_data_hash) reasons.push('reviewed_rows_changed');
  const wanted = new Set(request.ready_row_indices);
  if (!repeated && (wanted.size !== request.ready_row_indices.length || request.ready_row_indices.some((index) =>
    !Number.isSafeInteger(index) || index < 0 || index >= base.data.length))) reasons.push('invalid_reviewed_indices');
  if (!repeated && base.data.some((row, index) => wanted.has(index) && (!['ok', 'catch_all'].includes(String(row._email_status))
    || rec(row._ve_relevance).status !== 'relevant' || rec(row._ve_company_name).status !== 'ready')))
    reasons.push('reviewed_row_not_ready');
  if (reasons.length || !target || !required) return { status: 'blocked', reasons: [...new Set(reasons)] };

  const expected = { project_id: snapshot.project_id, setup_revision: snapshot.setup_revision, base_id: base.id,
    base_updated_at: base.updated_at, data_hash: dataHash, collect_info_hash: veGeographyRepairHash(info),
    preparation_hash: veGeographyRepairHash(prep), jobs_hash: veGeographyRepairHash(snapshot.jobs),
    children_hash: veGeographyRepairHash(snapshot.children) };
  const budget = { max_candidates: target.max_candidates, candidates_processed: target.candidates_processed,
    candidates_remaining: Math.max(0, target.max_candidates - target.candidates_processed), max_rounds: target.max_rounds,
    round: target.round, rounds_remaining: Math.max(0, target.max_rounds - target.round) };
  const continuationReasons: string[] = [];
  if (!budget.candidates_remaining || !budget.rounds_remaining) continuationReasons.push('original_budget_exhausted');
  if (target.stop_cause === 'low_yield') continuationReasons.push('existing_economic_hold');
  const preserved_job_results = snapshot.jobs.map((job) => ({ id: job.id, result_hash: veGeographyRepairHash(job.result) }));
  if (repeated) return { status: 'already_prepared', expected, budget, preserved_job_results,
    patch: { data: base.data, row_count: base.row_count, sample_rows: base.data.slice(0, 30), collect_info: info, analysis: null },
    continuation: { allowed: !continuationReasons.length && !!info.tasks?.length,
      reasons: continuationReasons, corrected_source_count: previous!.source_rewrites.length } };

  const kept = base.data.filter((_, index) => wanted.has(index));
  const held = base.data.filter((_, index) => !wanted.has(index));
  const states = info.tasks ?? [];
  const corrected = applyVeCollectionGeographyToPlan({ tasks: states.map((state) => state.task) }, required).tasks;
  const rewrites: VeGeographyRepairReceipt['source_rewrites'] = [];
  const retired: number[] = [];
  const tasks: VeCollectTaskState[] = [];
  states.forEach((state, index) => {
    const changed = veGeographyRepairHash(state.task) !== veGeographyRepairHash(corrected[index]);
    // These buffers were collected without the explicit geographic contract.
    // Their exact inputs and previous verdicts survive in previous_tasks.
    const clean = { ...state, ...(state.harvest ? { harvest: [] } : {}) };
    if (!changed) { tasks.push(clean); return; }
    const untouched = state.status === 'pending' && !state.child_job_id && !state.dispatched_at && !state.rows
      && !state.harvest?.length && !state.catalog && !state.directory_cursors;
    const free = ['companies_directory', 'yandex_maps'].includes(state.source) && !state.child_job_id
      && !['running', 'pending'].includes(state.status);
    if (!untouched && !free) { retired.push(index); return; }
    // A new scoped result set cannot inherit an old after/offset. Archive the
    // complete previous state, retain global seen/candidate/round accounting.
    tasks.push({ source: state.source, status: 'pending', child_job_id: null, rows: 0, task: corrected[index],
      ...(state.existing_contacts_only ? { existing_contacts_only: true as const } : {}) });
    rewrites.push({ index, reason: untouched ? 'fresh_pending' : 'free_scoped_cursor' });
  });
  if (!tasks.length) continuationReasons.push('no_safe_source');
  const receipt: VeGeographyRepairReceipt = { version: 1, repair_id: request.repair_id, prepared_at: request.prepared_at,
    required, original_data_hash: dataHash, original_collect_info_hash: expected.collect_info_hash,
    kept_data_hash: veGeographyRepairHash(kept), reviewed_ready_indices: [...request.ready_row_indices], held_ready_rows: held,
    held_candidate_buffers: { ...(info.relevance_reserve ? { relevance_reserve: info.relevance_reserve } : {}),
      ...(info.search_policy ? { search_policy: info.search_policy } : {}),
      ...(info.project_exclusion_reserve ? { project_exclusion_reserve: info.project_exclusion_reserve } : {}) },
    previous_tasks: states, retired_task_indices: retired, source_rewrites: rewrites,
    ...(info.construct ? { previous_construct: info.construct } : {}), ...(info.estimate ? { previous_estimate: info.estimate } : {}),
    ...(info.adaptive_collection ? { previous_adaptive_collection: info.adaptive_collection } : {}),
    ...(base.analysis != null ? { previous_analysis: base.analysis } : {}),
    ...(info.restaurant_source_refresh ? { previous_restaurant_source_refresh: info.restaurant_source_refresh } : {}),
    ...(info.audience_source_refresh ? { previous_audience_source_refresh: info.audience_source_refresh } : {}),
    source_keys: tasks.map((state) => veSourceStrategyKey(state.task)),
    budget: { max_rounds: target.max_rounds, max_candidates: target.max_candidates,
      initial_round: target.round, initial_candidates: target.candidates_processed },
    preserve_analysis: !!base.analysis && typeof base.analysis === 'object', preparation_stale: true,
    resume_policy: 'explicit_bounded_only' };
  const counted = countVeTargetContacts(kept, { limit: normalizeVeMaxEmailsPerCompany(base.max_emails_per_company), mode: 'preview' });
  const next: VeGeographyRepairInfo = { ...info, collection_geography: required, geography_repair: receipt,
    tasks, plan: { ...info.plan, tasks: tasks.map((state) => state.task) },
    target_progress: withVeTargetComposition({ ...target, ready_rows: counted.counted,
      status: counted.counted >= target.ready_target ? 'target_reached' : 'limited',
      reason: 'География проверенных контактов исправлена. Автоматическое продолжение не включено.' },
    counted, kept.length) };
  // Hold unreviewed candidates, but preserve every paid cache and source lineage.
  delete next.relevance_reserve;
  delete next.relevance_summary;
  delete next.project_exclusion_reserve;
  delete next.estimate;
  // The explicit geography receipt now owns source restrictions. The older
  // restaurant receipt binds an all-Russia cursor; retaining it would reject
  // the corrected region. Its full provenance is archived above.
  delete next.restaurant_source_refresh;
  delete next.audience_source_refresh;
  if (next.adaptive_collection) {
    next.adaptive_collection = { ...next.adaptive_collection, replan_needed: false,
      ...(tasks[0] ? { active_source: veSourceStrategyKey(tasks[0].task) } : {}) };
    delete next.adaptive_collection.replan_reason;
  }
  if (next.search_policy) next.search_policy = { ...next.search_policy, deferred_rows: [], construct_rows: [] };
  if (next.stats) next.stats = { ...next.stats, launchable_rows: kept.length };
  return { status: 'prepared', expected, budget, preserved_job_results,
    patch: { data: kept, row_count: kept.length, sample_rows: kept.slice(0, 30), collect_info: next, analysis: null },
    continuation: { allowed: !continuationReasons.length, reasons: continuationReasons, corrected_source_count: rewrites.length } };
}

/** Receipt validation runs before every repaired collection wake and before any
 * ordinary Continue can grant a new envelope. Missing receipt means legacy. */
export function readVeGeographyRepair(info: VeCollectInfo): VeGeographyRepairReceipt | null {
  const value = (info as VeGeographyRepairInfo).geography_repair;
  if (value === undefined) return null;
  const target = info.target_progress;
  if (!value || value.version !== 1 || value.resume_policy !== 'explicit_bounded_only' || !value.repair_id
    || !value.budget || !target || info.collection_mode !== 'preview' || info.supply_batch_id || info.refill
    || veGeographyRepairHash(readVeCollectionGeography(info.collection_geography)) !== veGeographyRepairHash(value.required)
    || !Number.isSafeInteger(value.budget.max_rounds) || value.budget.max_rounds < 1
    || !Number.isSafeInteger(value.budget.max_candidates) || value.budget.max_candidates < 1
    || target.max_rounds !== value.budget.max_rounds || target.max_candidates !== value.budget.max_candidates
    || [value.budget.initial_round, value.budget.initial_candidates, target.round, target.candidates_processed]
      .some((n) => !Number.isSafeInteger(n) || n < 0)
    || target.round < value.budget.initial_round || target.round > value.budget.max_rounds
    || target.candidates_processed < value.budget.initial_candidates
    || !Array.isArray(value.source_keys) || value.source_keys.some((key) => typeof key !== 'string' || !key)
    || !Array.isArray(info.tasks) || !Array.isArray(info.plan?.tasks)
    || info.tasks.some((state) => !value.source_keys.includes(veSourceStrategyKey(state.task)))
    || info.plan.tasks.some((task) => !value.source_keys.includes(veSourceStrategyKey(task)))
    || info.tasks.length !== info.plan.tasks.length)
    throw new Error('Invalid bounded geography repair checkpoint');
  return value;
}

/** Opens exactly one new round within the old envelope. Already open rounds
 * are not re-opened; the applier owns enqueue idempotency via continuation_job_id. */
export function prepareVeGeographyRepairContinuation(info: VeCollectInfo): {
  collect_info: VeCollectInfo; can_continue: boolean; reason: string | null;
} {
  const receipt = readVeGeographyRepair(info);
  if (!receipt || !info.target_progress) throw new Error('Explicit geography repair required');
  const target = info.target_progress;
  const fail = (reason: string) => ({ collect_info: info, can_continue: false, reason });
  if (target.ready_rows >= target.ready_target) return fail('target_reached');
  if (target.stop_cause === 'low_yield') return fail('existing_economic_hold');
  if (target.candidates_processed >= receipt.budget.max_candidates) return fail('candidate_limit');
  if (target.round >= receipt.budget.max_rounds) return fail('round_limit');
  if (!info.tasks?.length) return fail('no_safe_source');
  if (info.target_checkpoint?.completed_round !== target.round || info.validation_retry || info.company_name_recovery
    || info.relevance_review_requested || info.preview_pipeline?.batches.length || info.preview_pipeline?.active_batch_id
    || info.adaptive_collection?.pending || info.construct?.status === 'dispatched' || info.saved_email_recovery?.batch)
    return fail('saved_pipeline_not_drained');
  const next: VeCollectInfo = { ...info, target_progress: { ...target, round: target.round + 1, status: 'collecting' } };
  delete next.target_progress!.reason;
  delete next.target_progress!.stop_cause;
  delete next.construct;
  if (next.stats) { next.stats = { ...next.stats }; delete next.stats.finished_at; }
  if (next.search_policy) { next.search_policy = { ...next.search_policy }; delete next.search_policy.construct_rows; }
  next.limit = collectionRoundLimit(next.target_progress!);
  return { collect_info: next, can_continue: true, reason: null };
}

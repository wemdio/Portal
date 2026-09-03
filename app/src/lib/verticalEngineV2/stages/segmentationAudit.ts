/**
 * Async pre-launch segmentation audit.
 *
 * The stage classifies the exact launchable audience once, persists a stable
 * row assignment snapshot and exposes only its aggregate summary through the
 * API.  The same pure preparation/hash contract is reused by GET and launch,
 * so a changed template or base fails closed without another LLM call.
 */

import type {
  VeBase,
  VeChainLetter,
  VeJob,
  VeOperatorMapping,
  VeSegmentationAudit,
  VeSegmentationAuditAssignment,
  VeSegmentationAuditSummary,
  VeTemplate,
} from '../types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isContactSupplyActive } from '../contactSupplyEligibility';
import { VE_LAUNCH_MAX_LEADS } from '../launchHandoff';
import {
  classifyBaseRowsIntoSegmentsDetailed,
  detectSegmentLanguage,
  type DetailedSegmentClassificationResult,
} from '../segmentClassify';
import {
  buildSegmentationAudit,
  collectSegmentationConditions,
  computeSegmentationAuditHash,
  prepareSegmentationAudience,
  type PreparedSegmentationAudience,
  type SegmentationAuditReport,
} from '../segmentationAudit';
import { payloadString, requeueVeJob, stageLog, type VeStageContext, type VeStageResult, type VeUsage } from './shared';

type TemplateSnapshot = Pick<
  VeTemplate,
  'id' | 'base_id' | 'letters' | 'personalization_plan' | 'status'
>;

type BaseSnapshot = Pick<VeBase, 'id' | 'project_id' | 'columns' | 'data' | 'source'>;

export interface PreparedAuditSnapshot {
  segments: string[];
  audience: PreparedSegmentationAudience;
}

function objectRows(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  // Preserve source-row positions: malformed JSON entries become invalid
  // empty rows and are reconciled by the same email gate as launch.
  return raw.map((row) =>
    row && typeof row === 'object' && !Array.isArray(row)
      ? (row as Record<string, unknown>)
      : {},
  );
}

function stringArray(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === 'string')
    : [];
}

function templateLetters(raw: unknown): VeChainLetter[] {
  return Array.isArray(raw)
    ? raw.filter(
        (letter): letter is VeChainLetter =>
          Boolean(letter) && typeof letter === 'object' && !Array.isArray(letter),
      )
    : [];
}

function operatorMapping(raw: unknown): VeOperatorMapping[] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const mapping = (raw as { operator_mapping?: unknown }).operator_mapping;
  return Array.isArray(mapping) ? (mapping as VeOperatorMapping[]) : undefined;
}

/** Exact deterministic input preparation shared by worker and freshness GET. */
export function prepareAuditSnapshot(
  template: TemplateSnapshot,
  base: BaseSnapshot,
): PreparedAuditSnapshot {
  const letters = templateLetters(template.letters);
  const segments = collectSegmentationConditions(letters);
  const audience = prepareSegmentationAudience({
    rows: objectRows(base.data),
    columns: stringArray(base.columns),
    source: base.source,
    operatorMapping: operatorMapping(template.personalization_plan),
  });
  return { segments, audience };
}

function storageExample(example: { rowIndex: number; label: string; email: string }) {
  return {
    row_index: example.rowIndex,
    label: example.label,
    email: example.email,
  };
}

/** Camel-case pure report -> stable snake_case DB/API summary. */
export function toStoredAuditSummary(report: SegmentationAuditReport): VeSegmentationAuditSummary {
  const coveredRows = report.launchableRows - report.unclassifiedCount;
  return {
    version: 1,
    status: report.status,
    base_rows_total: report.totalRows,
    total_base_rows: report.totalRows,
    launchable_rows_total: report.launchableRows,
    launchable_rows: report.launchableRows,
    covered_rows_total: coveredRows,
    default_rows_total: report.default.count,
    unclassified_rows_total: report.unclassifiedCount,
    unclassified_count: report.unclassifiedCount,
    excluded: {
      low_relevance: report.excluded.lowRelevance,
      relevance_unchecked: report.excluded.relevanceUnchecked,
      invalid_verification: report.excluded.invalidEmailStatus,
      invalid_email_status: report.excluded.invalidEmailStatus,
      invalid_email: report.excluded.invalidEmail,
      duplicate_email: report.excluded.duplicateEmail,
    },
    segments: report.segments.map((segment) => ({
      key: segment.when,
      count: segment.count,
      share_pct: segment.sharePct,
      examples: segment.examples.map(storageExample),
    })),
    default: {
      count: report.default.count,
      share_pct: report.default.sharePct,
      examples: report.default.examples.map(storageExample),
    },
    failed_batches: report.failedBatches,
    total_batches: report.totalBatches,
  };
}

function numberField(record: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

type StoredAssignmentsResult =
  | { state: 'ok'; assignments: Map<number, string | null> }
  | { state: 'incomplete'; reason: string }
  | { state: 'stale'; reason: string };

function storedAssignments(
  raw: unknown,
  leadCount: number,
  segments: string[],
): StoredAssignmentsResult {
  if (!Array.isArray(raw) || raw.length !== leadCount) {
    return { state: 'incomplete', reason: 'assignments_coverage' };
  }
  const canonical = new Map(segments.map((segment) => [segment.toLowerCase(), segment]));
  const result = new Map<number, string | null>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { state: 'incomplete', reason: 'assignments_shape' };
    }
    const rowIndex = (entry as { row_index?: unknown }).row_index;
    const rawSegment = (entry as { segment?: unknown }).segment;
    if (!Number.isInteger(rowIndex) || (rowIndex as number) < 0 || (rowIndex as number) >= leadCount) {
      return { state: 'incomplete', reason: 'assignments_row_index' };
    }
    if (result.has(rowIndex as number)) {
      return { state: 'incomplete', reason: 'assignments_duplicate_row' };
    }
    if (rawSegment === null) {
      result.set(rowIndex as number, null);
      continue;
    }
    if (typeof rawSegment !== 'string') {
      return { state: 'stale', reason: 'assignment_segment_shape' };
    }
    const segment = canonical.get(rawSegment.trim().toLowerCase());
    if (!segment) return { state: 'stale', reason: 'assignment_segment_changed' };
    result.set(rowIndex as number, segment);
  }
  return result.size === leadCount
    ? { state: 'ok', assignments: result }
    : { state: 'incomplete', reason: 'assignments_coverage' };
}

function sameStrings(left: unknown, right: string[]): boolean {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameExcluded(
  summary: Record<string, unknown>,
  expected: SegmentationAuditReport,
): boolean {
  const excluded = summary.excluded;
  if (!excluded || typeof excluded !== 'object' || Array.isArray(excluded)) return false;
  const values = excluded as Record<string, unknown>;
  return (
    numberField(values, 'low_relevance') === expected.excluded.lowRelevance &&
    (numberField(values, 'relevance_unchecked', 'relevanceUnchecked') ?? 0) ===
      expected.excluded.relevanceUnchecked &&
    numberField(values, 'invalid_verification', 'invalid_email_status') ===
      expected.excluded.invalidEmailStatus &&
    numberField(values, 'invalid_email') === expected.excluded.invalidEmail &&
    numberField(values, 'duplicate_email') === expected.excluded.duplicateEmail
  );
}

function sameBuckets(summary: Record<string, unknown>, expected: SegmentationAuditReport): boolean {
  const storedSegments = summary.segments;
  const storedDefault = summary.default;
  if (!Array.isArray(storedSegments)) return false;
  if (!storedDefault || typeof storedDefault !== 'object' || Array.isArray(storedDefault)) return false;
  const bucketByKey = new Map<string, { count: number; sharePct: number }>();
  for (const raw of storedSegments) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const bucket = raw as Record<string, unknown>;
    const key = [bucket.key, bucket.when, bucket.segment].find(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    const count = numberField(bucket, 'count');
    const sharePct = numberField(bucket, 'share_pct', 'sharePct');
    if (!key || count === null || sharePct === null || bucketByKey.has(key)) return false;
    bucketByKey.set(key, { count, sharePct });
  }
  if (bucketByKey.size !== expected.segments.length) return false;
  if (
    expected.segments.some((segment) => {
      const stored = bucketByKey.get(segment.when);
      return stored?.count !== segment.count || stored.sharePct !== segment.sharePct;
    })
  ) {
    return false;
  }
  const defaultBucket = storedDefault as Record<string, unknown>;
  return (
    numberField(defaultBucket, 'count') === expected.default.count &&
    numberField(defaultBucket, 'share_pct', 'sharePct') === expected.default.sharePct
  );
}

export type StoredAuditValidation =
  | {
      state: 'current';
      snapshot: PreparedAuditSnapshot;
      assignments: Map<number, string | null>;
    }
  | { state: 'incomplete'; reason: string }
  | { state: 'stale'; reason: string };

export interface StoredAuditValidationInput {
  audit: Pick<
    VeSegmentationAudit,
    | 'project_id'
    | 'template_id'
    | 'base_id'
    | 'status'
    | 'input_hash'
    | 'segment_keys'
    | 'summary'
    | 'assignments'
  >;
  template: TemplateSnapshot;
  base: BaseSnapshot;
}

/**
 * Single fail-closed validator shared by GET and launch.
 *
 * `incomplete` means the async audit has not produced a fully classified
 * audience yet. `stale` means it was produced for different/currently changed
 * inputs (or its persisted integrity contract no longer matches).
 */
export function validateStoredAuditSnapshot(
  input: StoredAuditValidationInput,
): StoredAuditValidation {
  const { audit, template, base } = input;
  if (audit.status !== 'ready') {
    return { state: 'incomplete', reason: 'audit_not_ready' };
  }
  if (
    audit.project_id !== base.project_id ||
    audit.template_id !== template.id ||
    audit.base_id !== template.base_id ||
    audit.base_id !== base.id
  ) {
    return { state: 'stale', reason: 'identity_mismatch' };
  }
  if (typeof audit.input_hash !== 'string' || !/^[0-9a-f]{64}$/.test(audit.input_hash)) {
    return { state: 'stale', reason: 'input_hash_invalid' };
  }

  try {
    const snapshot = prepareAuditSnapshot(template, base);
    if (!sameStrings(audit.segment_keys, snapshot.segments)) {
      return { state: 'stale', reason: 'segment_keys_changed' };
    }
    const parsedAssignments = storedAssignments(
      audit.assignments,
      snapshot.audience.leads.length,
      snapshot.segments,
    );
    if (parsedAssignments.state !== 'ok') return parsedAssignments;
    const { assignments } = parsedAssignments;

    const summary = audit.summary;
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
      return { state: 'incomplete', reason: 'summary_missing' };
    }
    const rawSummary = summary as unknown as Record<string, unknown>;
    const summaryStatus = rawSummary.status;
    if (summaryStatus === 'incomplete') {
      return { state: 'incomplete', reason: 'summary_incomplete' };
    }
    if (
      summaryStatus !== undefined &&
      summaryStatus !== 'complete' &&
      summaryStatus !== 'not_required'
    ) {
      return { state: 'incomplete', reason: 'summary_status' };
    }
    const storedBaseRows = numberField(rawSummary, 'base_rows_total', 'total_base_rows');
    const storedLaunchable = numberField(
      rawSummary,
      'launchable_rows_total',
      'launchable_rows',
    );
    if (
      storedBaseRows !== snapshot.audience.totalRows ||
      storedLaunchable !== snapshot.audience.leads.length
    ) {
      return { state: 'stale', reason: 'audience_counts_changed' };
    }
    const unclassified = numberField(
      rawSummary,
      'unclassified_rows_total',
      'unclassified_count',
    );
    if (
      unclassified !== 0 ||
      numberField(rawSummary, 'covered_rows_total') !== storedLaunchable
    ) {
      return { state: 'incomplete', reason: 'summary_coverage' };
    }

    const recomputedHash = computeSegmentationAuditHash({
      templateId: template.id,
      baseId: base.id,
      segments: snapshot.segments,
      audience: snapshot.audience,
      assignments,
    });
    if (recomputedHash !== audit.input_hash) {
      return { state: 'stale', reason: 'input_hash_mismatch' };
    }

    const classification: DetailedSegmentClassificationResult = {
      assignments,
      unclassifiedRows: [],
      failedBatches: 0,
      totalBatches: 0,
      usage: { tokensUsed: 0, costUsd: 0 },
    };
    const expected = buildSegmentationAudit({
      templateId: template.id,
      baseId: base.id,
      segments: snapshot.segments,
      audience: snapshot.audience,
      classification,
    });
    if (
      expected.status === 'incomplete' ||
      numberField(rawSummary, 'version') !== 1 ||
      (summaryStatus !== undefined && summaryStatus !== expected.status) ||
      numberField(rawSummary, 'default_rows_total') !== expected.default.count ||
      !sameExcluded(rawSummary, expected) ||
      !sameBuckets(rawSummary, expected)
    ) {
      return { state: 'stale', reason: 'summary_mismatch' };
    }
    return { state: 'current', snapshot, assignments };
  } catch {
    return { state: 'stale', reason: 'validation_error' };
  }
}

/** Boolean compatibility wrapper for API/UI callers. */
export function isStoredAuditCurrent(input: StoredAuditValidationInput): boolean {
  return validateStoredAuditSnapshot(input).state === 'current';
}

/** Terminal worker failure hook; kept here so lifecycle writes stay DRY/testable. */
export async function markSegmentationAuditFailed(
  supabase: SupabaseClient,
  job: VeJob,
  error: unknown,
  now = new Date(),
): Promise<void> {
  if (job.stage !== 'segmentation_audit') return;
  const auditId = typeof job.payload?.audit_id === 'string' ? job.payload.audit_id : null;
  if (!auditId) return;
  const message = error instanceof Error ? error.message : String(error);
  const completedAt = now.toISOString();
  const { error: updateError } = await supabase
    .from('ve_segmentation_audits')
    .update({
      status: 'failed',
      error: message.slice(0, 500),
      completed_at: completedAt,
      updated_at: completedAt,
    })
    .eq('id', auditId)
    .in('status', ['pending', 'running']);
  if (updateError) {
    throw new Error(`ve_segmentation_audits fail: ${updateError.message}`);
  }
}

export async function runSegmentationAuditStage(
  job: VeJob,
  ctx: VeStageContext,
): Promise<VeStageResult> {
  const auditId = payloadString(job, 'audit_id');

  const { data: auditRow, error: auditError } = await ctx.supabase
    .from('ve_segmentation_audits')
    .select('*')
    .eq('id', auditId)
    .eq('project_id', job.project_id)
    .single();
  if (auditError || !auditRow) {
    throw new Error(`ve_segmentation_audits ${auditId}: ${auditError?.message ?? 'not found'}`);
  }
  const audit = auditRow as VeSegmentationAudit;
  const supplyBatchId = typeof job.payload?.supply_batch_id === 'string' ? job.payload.supply_batch_id : null;
  let supplyPlanId: string | null = null;
  let supplyRevision: string | null = null;
  const holdSupplyAudit = async (usage?: VeUsage): Promise<VeStageResult> => {
    await requeueVeJob(ctx, job, 5 * 60_000);
    return { result: { audit_id: audit.id, waiting: true, supply_hold: true }, ...usage };
  };
  const readSupplyRevision = async () => {
    if (!supplyPlanId) return null;
    const { data: revision, error: revisionError } = await ctx.supabase.rpc('ve_contact_supply_preview_revision', {
      p_template_id: audit.template_id,
    });
    if (revisionError || typeof revision !== 'string' || !/^[0-9a-f]{32}$/.test(revision)) {
      throw new Error('Supply audit source revision is unavailable');
    }
    return revision;
  };
  if (supplyBatchId) {
    const { data: batch, error: batchError } = await ctx.supabase.from('ve_contact_supply_batches')
      .select('id, plan_id, base_id, template_id, audit_id, status').eq('id', supplyBatchId).maybeSingle();
    if (batchError || !batch || batch.base_id !== audit.base_id || batch.template_id !== audit.template_id
      || batch.audit_id !== audit.id || !['auditing', 'ready', 'appended'].includes(batch.status)) {
      throw new Error('Supply audit batch identity does not match');
    }
    const { data: plan, error: planError } = await ctx.supabase.from('ve_contact_supply_plans')
      .select('id, project_id, status').eq('id', batch.plan_id).maybeSingle();
    if (planError || !plan || plan.project_id !== job.project_id) {
      throw new Error('Supply audit plan does not belong to this project');
    }
    supplyPlanId = plan.id;
    if (!await isContactSupplyActive(ctx.supabase, plan.id)) return holdSupplyAudit();
    supplyRevision = await readSupplyRevision();
  }

  // Idempotent recovery: the stage may have persisted the snapshot just
  // before a worker restart but not yet marked ve_jobs done.
  if (audit.status === 'ready' && audit.summary && audit.input_hash) {
    if (supplyRevision && (auditRow as { supply_source_revision?: unknown }).supply_source_revision !== supplyRevision) {
      throw new Error('Supply audit source changed after classification');
    }
    return {
      result: {
        audit_id: audit.id,
        status: audit.summary.status,
        input_hash: audit.input_hash,
        summary: audit.summary,
      },
      tokensUsed: audit.tokens_used ?? 0,
      costUsd: Number(audit.cost_usd ?? 0),
    };
  }
  if (audit.status === 'failed' || audit.status === 'cancelled') {
    throw new Error(`Segmentation audit ${audit.id} is ${audit.status}`);
  }

  const now = new Date().toISOString();
  const { data: claimedAudit, error: claimError } = await ctx.supabase
    .from('ve_segmentation_audits')
    .update({ status: 'running', error: null, updated_at: now })
    .eq('id', audit.id)
    .in('status', ['pending', 'running'])
    .select('id')
    .maybeSingle();
  if (claimError || !claimedAudit) {
    throw new Error(`ve_segmentation_audits claim: ${claimError?.message ?? 'not active'}`);
  }

  const { data: templateRow, error: templateError } = await ctx.supabase
    .from('ve_templates')
    .select('id, base_id, letters, personalization_plan, status')
    .eq('id', audit.template_id)
    .single();
  if (templateError || !templateRow) {
    throw new Error(`ve_templates ${audit.template_id}: ${templateError?.message ?? 'not found'}`);
  }
  const template = templateRow as TemplateSnapshot;
  if (template.status !== 'ready') throw new Error('Segmentation audit requires a ready template');
  if (template.base_id !== audit.base_id) throw new Error('Segmentation audit base is stale');

  const { data: baseRow, error: baseError } = await ctx.supabase
    .from('ve_bases')
    .select('id, project_id, columns, data, source')
    .eq('id', audit.base_id)
    .single();
  if (baseError || !baseRow) {
    throw new Error(`ve_bases ${audit.base_id}: ${baseError?.message ?? 'not found'}`);
  }
  const base = baseRow as BaseSnapshot;
  if (base.project_id !== job.project_id || audit.project_id !== job.project_id) {
    throw new Error('Segmentation audit project mismatch');
  }

  const snapshot = prepareAuditSnapshot(template, base);
  if (snapshot.audience.leads.length > VE_LAUNCH_MAX_LEADS) {
    throw new Error(
      `Аудитория ${snapshot.audience.leads.length} превышает лимит запуска ${VE_LAUNCH_MAX_LEADS}`,
    );
  }
  const classification = await classifyBaseRowsIntoSegmentsDetailed({
    rows: snapshot.audience.rows,
    segments: snapshot.segments,
    language: detectSegmentLanguage(snapshot.segments),
    log: (message) => stageLog(ctx, `[segmentation_audit] ${message}`),
  });
  const report = buildSegmentationAudit({
    templateId: template.id,
    baseId: base.id,
    segments: snapshot.segments,
    audience: snapshot.audience,
    classification,
  });
  const assignments: VeSegmentationAuditAssignment[] = [
    ...classification.assignments.entries(),
  ]
    .sort(([left], [right]) => left - right)
    .map(([rowIndex, segment]) => ({ row_index: rowIndex, segment }));
  const summary = toStoredAuditSummary(report);
  const completedAt = new Date().toISOString();
  if (supplyPlanId && !await isContactSupplyActive(ctx.supabase, supplyPlanId)) {
    return holdSupplyAudit(report.usage);
  }
  if (supplyRevision && await readSupplyRevision() !== supplyRevision) {
    throw new Error('Supply audit source changed during classification');
  }

  // status='running' protects a concurrent project cancellation from being
  // overwritten after the LLM call returns.
  const { data: saved, error: saveError } = await ctx.supabase
    .from('ve_segmentation_audits')
    .update({
      status: 'ready',
      input_hash: report.inputHash,
      segment_keys: snapshot.segments,
      summary,
      assignments,
      error: null,
      tokens_used: report.usage.tokensUsed,
      cost_usd: report.usage.costUsd,
      completed_at: completedAt,
      updated_at: completedAt,
      ...(supplyRevision ? {
        supply_source_revision: supplyRevision,
        supply_leads: snapshot.audience.leads,
      } : {}),
    })
    .eq('id', audit.id)
    .eq('status', 'running')
    .select('id')
    .maybeSingle();
  if (saveError || !saved) {
    throw new Error(`ve_segmentation_audits save: ${saveError?.message ?? 'audit no longer active'}`);
  }

  return {
    result: {
      audit_id: audit.id,
      status: summary.status,
      input_hash: report.inputHash,
      summary,
    },
    tokensUsed: report.usage.tokensUsed,
    costUsd: report.usage.costUsd,
  };
}

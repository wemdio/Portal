import type { SupabaseClient } from '@supabase/supabase-js';
import { isValidUuid } from '@/lib/apiValidation';

const COLLECTION_STATUSES = ['pending', 'processing', 'completed', 'failed', 'cancelled'] as const;
const COLLECTION_STEPS = [
  'find_emails',
  'enrich_descriptions',
  'split_emails',
  'dedup_email',
  'validate_emails',
  'cap_emails_per_company',
  'company_qualification',
  'done',
] as const;

export type EngCollectionStep = (typeof COLLECTION_STEPS)[number];

/** Display-only snapshot. It never resumes or otherwise changes a constructor job. */
export interface EngCollectionProgress {
  status: (typeof COLLECTION_STATUSES)[number];
  step_key: EngCollectionStep | null;
  /** Constructor steps are one-based; zero means no step has started yet. */
  step_index: number | null;
  total_steps: number | null;
  step_percent: number | null;
  /** Companies handed to the constructor, before splitting into email rows. */
  company_count: number | null;
  /** Last constructor heartbeat or company-check checkpoint, not a start time. */
  heartbeat_at: string | null;
  /** Present only while checking each company's audience and country evidence. */
  companies_checked?: number;
}

export interface EngCompanyQualificationSummary {
  total: number;
  checked: number;
  excluded: number;
}

const JOBS_LIMIT = 100;
const READ_TIMEOUT_MS = 5_000;
const PROGRESS_COLUMNS = 'id, status, current_step_key, current_step, total_steps, current_step_progress, initial_row_count, started_at';
type Row = Record<string, unknown>;

function record(value: unknown): Row | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Only aggregate counts leave the server, never evidence, verdicts or scope keys. */
export function engCompanyQualificationSummary(info: Row): EngCompanyQualificationSummary | null {
  // Dashboard reads this small checkpoint instead of every company's evidence.
  const progress = record(info.eng_company_qualification_progress);
  const progressTotal = count(progress?.total);
  const progressChecked = count(progress?.checked);
  const progressExcluded = count(progress?.excluded);
  if (progressTotal !== null && progressChecked !== null && progressExcluded !== null &&
    progressChecked <= progressTotal && progressExcluded <= progressChecked) {
    return { total: progressTotal, checked: progressChecked, excluded: progressExcluded };
  }
  const total = count(info.eng_company_qualification_total);
  const memo = record(info.eng_company_qualification);
  const verdicts = record(memo?.verdicts);
  if (total === null || memo?.version !== 1 || typeof memo.scopeKey !== 'string' || !memo.scopeKey || !verdicts) return null;
  let checked = 0;
  let excluded = 0;
  for (const [key, raw] of Object.entries(verdicts)) {
    const verdict = record(raw);
    if (!verdict || verdict.version !== 1 || verdict.scopeKey !== memo.scopeKey || verdict.companyKey !== key ||
      !['accepted', 'rejected', 'unverified'].includes(String(verdict.status))) continue;
    checked += 1;
    if (verdict.status !== 'accepted') excluded += 1;
  }
  // A stale/malformed memo must not show more companies checked than entered.
  return checked <= total ? { total, checked, excluded } : null;
}

function companyQualificationProgress(info: Row): EngCollectionProgress | null {
  const summary = engCompanyQualificationSummary(info);
  if (!summary) return null;
  const memo = record(info.eng_company_qualification);
  const updatedAt = record(info.eng_company_qualification_progress)?.updated_at;
  let heartbeat = typeof updatedAt === 'string' ? Date.parse(updatedAt) : NaN;
  for (const raw of Object.values(record(memo?.verdicts) ?? {})) {
    const verdict = record(raw);
    if (!verdict || verdict.scopeKey !== memo?.scopeKey || typeof verdict.checkedAt !== 'string') continue;
    const checkedAt = Date.parse(verdict.checkedAt);
    if (Number.isFinite(checkedAt) && (!Number.isFinite(heartbeat) || checkedAt > heartbeat)) heartbeat = checkedAt;
  }
  return {
    status: 'processing',
    step_key: 'company_qualification',
    step_index: null,
    total_steps: null,
    step_percent: summary.total > 0 ? (summary.checked / summary.total) * 100 : 100,
    company_count: summary.total,
    companies_checked: summary.checked,
    heartbeat_at: Number.isFinite(heartbeat) ? new Date(heartbeat).toISOString() : null,
  };
}

function progressOf(row: Row): EngCollectionProgress | null {
  const status = COLLECTION_STATUSES.find((value) => value === row.status);
  if (!status) return null;
  const stepPercent = row.current_step_progress;
  const heartbeat = typeof row.started_at === 'string' ? Date.parse(row.started_at) : NaN;
  return {
    status,
    step_key: COLLECTION_STEPS.find((value) => value === row.current_step_key) ?? null,
    step_index: count(row.current_step),
    total_steps: count(row.total_steps),
    step_percent: typeof stepPercent === 'number' && Number.isFinite(stepPercent) && stepPercent >= 0 && stepPercent <= 100
      ? stepPercent : null,
    company_count: count(row.initial_row_count),
    heartbeat_at: Number.isFinite(heartbeat) ? new Date(heartbeat).toISOString() : null,
  };
}

/**
 * ENG detail only: bases must already belong to the owner-scoped project.
 * One bounded metadata read, additionally restricted to the authenticated owner.
 * Eligible bases always get an entry: null means the snapshot is unavailable.
 * No constructor GET/repair path, raw data, result_stats, or error text is read.
 */
export async function readHeEngCollectionProgress(
  db: SupabaseClient,
  ownerId: string,
  scopedBases: readonly unknown[],
): Promise<Map<string, EngCollectionProgress | null>> {
  const progress = new Map<string, EngCollectionProgress | null>();
  const basesByJob = new Map<string, string[]>();
  for (const raw of scopedBases) {
    const base = record(raw);
    if (!base || base.status !== 'collecting' || typeof base.id !== 'string') continue;
    const info = record(base.collect_info);
    const qualification = info ? companyQualificationProgress(info) : null;
    if (qualification) {
      progress.set(base.id, qualification);
      continue;
    }
    const construct = record(info?.construct);
    if (construct?.status !== 'dispatched') continue;
    progress.set(base.id, null);
    const jobId = construct.bc_job_id;
    if (typeof jobId !== 'string' || !isValidUuid(jobId)) continue;
    if (!basesByJob.has(jobId) && basesByJob.size >= JOBS_LIMIT) continue;
    basesByJob.set(jobId, [...(basesByJob.get(jobId) ?? []), base.id]);
  }
  if (basesByJob.size === 0 || !isValidUuid(ownerId)) return progress;

  try {
    const { data, error } = await db
      .from('base_constructor_jobs')
      .select(PROGRESS_COLUMNS)
      .eq('user_id', ownerId)
      .in('id', [...basesByJob.keys()])
      .limit(basesByJob.size)
      .abortSignal(AbortSignal.timeout(READ_TIMEOUT_MS));
    if (error || !Array.isArray(data)) return progress;
    for (const raw of data) {
      const row = record(raw);
      if (!row || typeof row.id !== 'string') continue;
      const baseIds = basesByJob.get(row.id);
      if (!baseIds) continue;
      const snapshot = progressOf(row);
      for (const baseId of baseIds) progress.set(baseId, snapshot);
    }
  } catch {
    // Best-effort telemetry must not fail the project detail or invent activity.
  }
  return progress;
}

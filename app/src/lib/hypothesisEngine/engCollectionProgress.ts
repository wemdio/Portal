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
  /** started_at is the constructor worker's last heartbeat, not a start time. */
  heartbeat_at: string | null;
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
    const construct = record(record(base.collect_info)?.construct);
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

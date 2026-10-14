import type { VeOutreachPreparation } from '@/lib/verticalEngineV2/outreachSetup';
import type { VeBaseSummary, VeContinuationCheck, VeJobSummary } from './api';

export interface VeAutomaticContinuationCandidate {
  key: string;
  projectId: string;
  hypothesisId: string;
  baseId: string;
  updatedAt: string;
  cacheRevision: number;
  status: string;
  setupRevision: number;
}

/** Select only cards currently shown, using their exact preparation/base link.
 * Polling never reads collection checkpoints itself. Unknown means inspect, not resume. */
export function veAutomaticContinuationCandidates(input: {
  projectId: string; step: number; activeHypothesisId: string; setupRevision: number;
  selectedHypothesisIds: readonly string[]; preparations: readonly VeOutreachPreparation[];
  bases: readonly VeBaseSummary[]; jobs: readonly VeJobSummary[]; launchedBaseIds: ReadonlySet<string>;
}): VeAutomaticContinuationCandidate[] {
  if (input.step !== 2 && input.step !== 3) return [];
  return input.preparations.flatMap((preparation) => {
    if (!input.selectedHypothesisIds.includes(preparation.hypothesis_id)
      || (input.step === 2 && preparation.hypothesis_id !== input.activeHypothesisId)
      || ['pending', 'generating'].includes(preparation.status)) return [];
    const base = input.bases.find((item) => item.id === preparation.base_id && item.hypothesis_id === preparation.hypothesis_id);
    if (!base || base.source !== 'auto' || !['analyzed', 'failed'].includes(base.status)
      || base.collect_info?.collection_mode !== 'preview' || base.collection_continuation?.code !== 'state_unchecked'
      || input.launchedBaseIds.has(base.id) || !base.updated_at
      || !Number.isFinite(Date.parse(base.updated_at)) || !Number.isSafeInteger(base.collection_continuation_revision)
      || Number(base.collection_continuation_revision) < 0
      || input.jobs.some((job) => job.payload?.base_id === base.id && ['pending', 'running'].includes(job.status)
        && ['base_collect', 'base_analyze', 'template', 'base_reproject_contacts'].includes(job.stage))) return [];
    const candidate = { projectId: input.projectId, hypothesisId: preparation.hypothesis_id, baseId: base.id,
      updatedAt: base.updated_at, cacheRevision: base.collection_continuation_revision!, status: base.status,
      setupRevision: input.setupRevision };
    return [{ ...candidate, key: JSON.stringify(candidate) }];
  });
}

/** A late answer cannot overwrite progress already observed by another GET. */
export function veAutomaticContinuationResultCurrent(
  candidate: VeAutomaticContinuationCandidate, checked: VeContinuationCheck,
  current: VeAutomaticContinuationCandidate | undefined,
): boolean {
  return current?.key === candidate.key && checked.base_id === candidate.baseId
    && checked.hypothesis_id === candidate.hypothesisId && checked.cache_revision === candidate.cacheRevision
    && !!checked.code && checked.code !== 'state_changed';
}

/** One request at a time, at most two attempts per persisted basis. Errors keep
 * the result unknown; re-rendering or polling cannot reset the retry allowance. */
export class VeAutomaticContinuationChecks {
  private attempts = new Map<string, { count: number; retryAt: number }>();
  private active: string | null = null;
  next(candidates: readonly VeAutomaticContinuationCandidate[], now: number): { candidate?: VeAutomaticContinuationCandidate; retryAt?: number } {
    if (this.active) return {};
    let retryAt: number | undefined;
    for (const candidate of candidates) {
      const attempt = this.attempts.get(candidate.key);
      if (!attempt || (attempt.count < 2 && attempt.retryAt <= now)) return { candidate };
      if (attempt.count < 2 && Number.isFinite(attempt.retryAt)) retryAt = Math.min(retryAt ?? Infinity, attempt.retryAt);
    }
    return { retryAt };
  }
  start(candidate: VeAutomaticContinuationCandidate, now: number): boolean {
    if (this.active) return false;
    const previous = this.attempts.get(candidate.key);
    if (previous && (previous.count >= 2 || previous.retryAt > now)) return false;
    this.attempts.set(candidate.key, { count: (previous?.count ?? 0) + 1, retryAt: Infinity });
    this.active = candidate.key;
    return true;
  }
  finish(candidate: VeAutomaticContinuationCandidate, retry: boolean, now: number): void {
    const previous = this.attempts.get(candidate.key);
    if (previous) this.attempts.set(candidate.key, { ...previous, retryAt: retry ? now + 30_000 : Infinity });
    if (this.active === candidate.key) this.active = null;
  }
}

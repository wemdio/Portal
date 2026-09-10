import type { VeRelevanceCheckpoint } from './relevanceCheckpoint';

export const VE_RELEVANCE_MAX_CONSECUTIVE_RETRIES = 4;
export const VE_RELEVANCE_MAX_TOTAL_RETRIES = 12;

interface VeRelevanceRetryProgress {
  websites: number;
  verdicts: number;
}

export interface VeRelevanceRetryState {
  context_hash: string;
  /** Total scheduled retries; never reset within the same job/context. */
  attempts: number;
  consecutive_attempts: number;
  progress: VeRelevanceRetryProgress;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function count(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}

/** Saved successful work, not errors, heartbeats, or repeated reads of a checkpoint. */
function completedProgress(checkpoint: VeRelevanceCheckpoint): VeRelevanceRetryProgress {
  return {
    websites: Object.values(checkpoint.website_evidence).filter((item) =>
      item.status !== 'error' && item.refined && !item.provider_error).length,
    verdicts: Object.values(checkpoint.verdicts).filter((item) => item.status !== 'error').length,
  };
}

/** A fresh provider failure may wait again after progress, within a durable total cap. */
export function planVeRelevanceRetry(
  previous: unknown,
  checkpoint: VeRelevanceCheckpoint,
  retryable: boolean,
): { retry: boolean; delayMs: number; state: VeRelevanceRetryState } {
  const candidate = record(previous);
  const saved = candidate?.context_hash === checkpoint.context_hash ? candidate : undefined;
  const current = completedProgress(checkpoint);
  const attempts = saved ? count(saved.attempts, VE_RELEVANCE_MAX_TOTAL_RETRIES) : 0;
  const watermark = record(saved?.progress);
  const oldProgress = {
    websites: count(watermark?.websites, current.websites),
    verdicts: count(watermark?.verdicts, current.verdicts),
  };
  // Legacy attempts have no progress watermark. Establish today's baseline
  // conservatively; do not forgive their already spent retry budget.
  const progressed = current.websites > oldProgress.websites || current.verdicts > oldProgress.verdicts;
  const consecutive = progressed ? 0 : count(saved?.consecutive_attempts, attempts);
  const retry = retryable && attempts < VE_RELEVANCE_MAX_TOTAL_RETRIES
    && consecutive < VE_RELEVANCE_MAX_CONSECUTIVE_RETRIES;
  return {
    retry,
    delayMs: retry ? Math.min(30_000 * 2 ** consecutive, 240_000) : 0,
    state: {
      context_hash: checkpoint.context_hash,
      attempts: attempts + Number(retry),
      consecutive_attempts: consecutive + Number(retry),
      progress: {
        websites: Math.max(current.websites, oldProgress.websites),
        verdicts: Math.max(current.verdicts, oldProgress.verdicts),
      },
    },
  };
}

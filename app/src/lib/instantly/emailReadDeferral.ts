export type InstantlyEmailReadDeferredReason =
  | 'budget'
  | 'recovery_budget'
  | 'bulk_budget'
  | 'interactive_budget'
  | 'cooldown'
  | 'storage_unavailable';

/** Every lane-specific denial ('recovery_budget' | 'bulk_budget' |
 * 'interactive_budget') plus the common-cap denial share the 'budget' family:
 * no LIST /emails attempt was sent to the provider, and callers treat them
 * identically. */
export function isBudgetDeferralReason(reason: InstantlyEmailReadDeferredReason): boolean {
  return reason === 'budget' || reason === 'recovery_budget' || reason === 'bulk_budget'
    || reason === 'interactive_budget';
}

export interface InstantlyEmailReadDeferral {
  reason: InstantlyEmailReadDeferredReason;
  retryAfterMs: number;
}

const DEFERRAL_MESSAGE_RE =
  /Instantly email read deferred:\s*(budget|recovery_budget|bulk_budget|interactive_budget|cooldown|storage_unavailable);\s*retry after (\d+(?:\.\d+)?) ms\b/i;

function isDeferralReason(value: unknown): value is InstantlyEmailReadDeferredReason {
  return value === 'budget' || value === 'recovery_budget' || value === 'bulk_budget'
    || value === 'interactive_budget' || value === 'cooldown' || value === 'storage_unavailable';
}

/** Pure recognition shared by retry scheduling and callers that preserve only
 * a wrapped Error.message. A local admission denial is not a provider 429. */
export function readInstantlyEmailReadDeferral(error: unknown): InstantlyEmailReadDeferral | null {
  let current = error;
  // Bounded traversal also handles an accidentally cyclic Error.cause chain.
  for (let depth = 0; depth < 5 && current != null; depth++) {
    const value = typeof current === 'object'
      ? current as { name?: unknown; reason?: unknown; retryAfterMs?: unknown; message?: unknown; cause?: unknown }
      : null;
    if (value?.name === 'InstantlyEmailReadDeferredError' &&
        isDeferralReason(value.reason) &&
        typeof value.retryAfterMs === 'number' && Number.isFinite(value.retryAfterMs) && value.retryAfterMs > 0) {
      return { reason: value.reason, retryAfterMs: Math.ceil(value.retryAfterMs) };
    }
    const message = typeof current === 'string' ? current : typeof value?.message === 'string' ? value.message : '';
    const match = message.match(DEFERRAL_MESSAGE_RE);
    if (match) {
      const retryAfterMs = Number(match[2]);
      if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
        return { reason: match[1].toLowerCase() as InstantlyEmailReadDeferredReason, retryAfterMs: Math.ceil(retryAfterMs) };
      }
    }
    current = value?.cause;
  }
  return null;
}

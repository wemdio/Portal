import type { TechStatus } from '@/lib/techCalendar/types';

export interface ExistingProviderSubscriptionDecision {
  status: TechStatus;
  next_billing_date: string;
  decision_by: string | null;
  decision_at: string | null;
  decision_notes: string | null;
}

interface ProviderSubscriptionState {
  status: TechStatus;
  next_billing_date: string;
}

/**
 * Provider sync owns technical metadata, but an administrator owns the
 * keep/cancel decision. Preserve that decision and its billing cycle until the
 * explicit renewal flow archives it; otherwise a nightly sync could erase a
 * reserved/paid cost from the company budget.
 */
export function mergeProviderSubscriptionDecision(
  existing: ExistingProviderSubscriptionDecision | undefined,
  provider: ProviderSubscriptionState,
): ExistingProviderSubscriptionDecision {
  const isManualCancel = existing?.status === 'cancel'
    && (existing.decision_by !== null || existing.decision_at !== null);

  if (existing && (existing.status === 'keep' || isManualCancel)) {
    return existing;
  }

  return {
    ...provider,
    decision_by: null,
    decision_at: null,
    decision_notes: null,
  };
}

/** A due accepted cycle is immutable until the paid-renew action archives it. */
export function isDueKeptProviderCycle(
  existing: ExistingProviderSubscriptionDecision | undefined,
  today: string,
): boolean {
  return existing?.status === 'keep' && existing.next_billing_date <= today;
}

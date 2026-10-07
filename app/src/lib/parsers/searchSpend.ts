import { searchQueueDeadline } from './searchExecution';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ProviderBudgetWaitError, ProviderUsageWriteError, type ProviderUsageEvent } from '@/lib/providerUsage';

/** Unknown billing keeps the full reservation. A timeout never refunds money. */
export async function accountSearchSpend(db: SupabaseClient, baseId: string, event: ProviderUsageEvent): Promise<boolean> {
  if (event.phase === 'started') {
    const { data, error } = await searchQueueDeadline(db.rpc('ve_reserve_search_spend', {
      p_base_id: baseId, p_attempt_id: event.attemptId, p_reserved_usd: event.reservedCostUsd ?? null,
    })).catch(() => { throw new ProviderUsageWriteError(); });
    if (error) throw new ProviderUsageWriteError();
    if (data !== 'reserved' && data !== 'not_applicable') throw new ProviderBudgetWaitError(String(data));
    return data === 'reserved';
  } else {
    // Only provider-reported billing releases a reservation; token estimates
    // are useful telemetry, but are not a receipt from the provider.
    const actual = event.reportedCostUsd ?? null;
    const { error } = await searchQueueDeadline(db.rpc('ve_settle_search_spend', { p_attempt_id: event.attemptId, p_actual_usd: actual }))
      .catch(() => { throw new ProviderUsageWriteError(); });
    if (error) throw new ProviderUsageWriteError();
    return true;
  }
}

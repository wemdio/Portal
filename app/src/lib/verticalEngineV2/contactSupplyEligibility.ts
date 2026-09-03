import type { SupabaseClient } from '@supabase/supabase-js';

/** Expected eligibility holds are not worker failures; infrastructure errors are. */
export async function isContactSupplyActive(
  supabase: SupabaseClient,
  planId: string,
  now = new Date(),
): Promise<boolean> {
  const { error } = await supabase.rpc('ve_require_contact_supply_active', {
    p_plan_id: planId,
    p_now: now.toISOString(),
  });
  if (!error) return true;
  if (/^(supply plan is not active|supply approval rules are stale|supply requires active campaign)/.test(error.message)) {
    return false;
  }
  throw new Error(`supply eligibility check: ${error.message}`);
}

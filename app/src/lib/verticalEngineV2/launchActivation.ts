import type { SupabaseClient } from '@supabase/supabase-js';

export interface VeLaunchActivationOutcome { status: number; body: Record<string, unknown> }
export interface VeLaunchActivationInput {
  portalDb: SupabaseClient; itemId: string; actorId: string;
  body: { confirm_campaign_review?: unknown; idempotency_key?: unknown; plan_version?: unknown };
}

/** Retired endpoint: stale Portal pages must not start a campaign. */
export async function activateVeLaunchPortfolioItem(_input: VeLaunchActivationInput): Promise<VeLaunchActivationOutcome> {
  return {status: 409, body: {code: 'VE_START_IN_INSTANTLY',
    error: 'Проверьте кампанию и нажмите Start в Instantly. В Portal подтверждать запуск больше не нужно.'}};
}

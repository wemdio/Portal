import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { cached } from '@/lib/clientCache';
import { computeOnboardingStatus } from '@/lib/clientOnboarding/checkStatus';
import { logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

/**
 * Onboarding checklist for /client/dashboard.
 *
 * Returns a 5-step progress object (see computeOnboardingStatus). Wrapped in
 * a 15-second TTL cache because the dashboard polls this on mount and we
 * don't want a cold-tap on the database every page navigation.
 *
 * staleMs=0 → no stale-while-revalidate. Onboarding state changes on user
 * action (saving brief, launching campaign), and we want clients to see
 * fresh state quickly after they take that action — eventual 15s consistency.
 */
const CACHE_TTL_MS = 15_000;

export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  const adminClient = supabaseAdmin;
  const instantlyClient = supabaseInstantly;
  if (!adminClient || !instantlyClient) return jsonError('Server misconfigured', 500);

  const { userId } = result.auth;

  try {
    const status = await cached(
      `client-onboarding:${userId}`,
      () =>
        computeOnboardingStatus(userId, {
          supabaseAdmin: adminClient,
          supabaseInstantly: instantlyClient,
        }),
      CACHE_TTL_MS,
      0,
    );
    return NextResponse.json(status);
  } catch (err) {
    await logError('client.onboarding.status.failed', err, { userId });
    return jsonError('Не удалось загрузить статус онбординга', 500);
  }
}

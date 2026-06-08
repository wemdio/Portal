import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

// In-memory cache: the facets GROUP-BYs scan the whole catalog, so run them at
// most once an hour across all users of this worker.
let cache: { at: number; data: unknown } | null = null;
const TTL_MS = 60 * 60 * 1000;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);
  const supabase = createAuthedSupabaseClient(token);
  const { data: userData, error: authErr } = await supabase.auth.getUser();
  if (authErr || !userData?.user) return jsonError('Unauthorized', 401);

  if (cache && Date.now() - cache.at < TTL_MS) {
    return NextResponse.json(cache.data);
  }

  const { data, error } = await supabase.rpc('pdl_facets');
  if (error) {
    await logError('company_base.facets.failed', error, undefined, { userId: userData.user.id });
    return jsonError(error.message, 500);
  }
  cache = { at: Date.now(), data };
  return NextResponse.json(data);
}

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { applyFundedFilters } from '@/lib/funded/queryFilters';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function listParam(sp: URLSearchParams, key: string): string[] {
  return Array.from(
    new Set(
      sp.getAll(key).flatMap((v) => v.split(',')).map((v) => v.trim().toLowerCase()).filter(Boolean),
    ),
  );
}

export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);
  const supabase = createAuthedSupabaseClient(token);
  const { data: userData, error: authErr } = await supabase.auth.getUser();
  if (authErr || !userData?.user) return jsonError('Unauthorized', 401);

  const sp = req.nextUrl.searchParams;
  const source = listParam(sp, 'source');
  const country = listParam(sp, 'country');
  const industry = listParam(sp, 'industry');
  const stage = listParam(sp, 'stage');
  const hasFunding = sp.get('has_funding') === '1';
  const minFundingRaw = Number(sp.get('min_funding') ?? '');
  const minFunding = Number.isFinite(minFundingRaw) && minFundingRaw > 0 ? Math.round(minFundingRaw) : null;
  const fundedSince = (sp.get('funded_since') ?? '').trim() || null;
  const name = (sp.get('name') ?? '').trim();

  // EXACT count(*), same filter chain as /api/funded/search. The table is
  // small (~40k rows) so a real count is instant — and unlike the retired
  // planner-estimate RPC it stays correct when filters correlate (e.g.
  // industry='b2b' (all YC) x funded_since (YC has no funding dates) = 0,
  // which the estimate misreported as ≈1700).
  // (cast: the concrete postgrest generic is too deep for tsc; the helper
  // mutates the builder in place and we await the builder itself)
  const query = supabase.from('funded_companies').select('*', { count: 'exact', head: true });
  applyFundedFilters(query as never, { source, country, industry, stage, hasFunding, minFunding, fundedSince, name });
  const { count, error } = await query;
  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ estimate: count ?? 0, exact: true });
}

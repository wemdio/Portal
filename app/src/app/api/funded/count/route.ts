import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

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

  const { data, error } = await supabase.rpc('funded_count_estimate', {
    p_source: source.length ? source : null,
    p_country: country.length ? country : null,
    p_industry: industry.length ? industry : null,
    p_stage: stage.length ? stage : null,
    p_has_funding: hasFunding || minFunding != null || fundedSince != null ? true : null,
    p_min_funding: minFunding,
    p_funded_since: fundedSince,
    p_name: name || null,
  });
  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ estimate: Number(data ?? 0) });
}

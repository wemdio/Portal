import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...(extra ?? {}) }, { status });
}

async function getSupabase(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { error: jsonError('Unauthorized', 401) };
  const supabase = createAuthedSupabaseClient(token);
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) return { error: jsonError('Unauthorized', 401) };
    return { supabase, user: data.user };
  } catch {
    return { error: jsonError('Unauthorized', 401) };
  }
}

function listParam(sp: URLSearchParams, key: string): string[] {
  return Array.from(
    new Set(sp.getAll(key).flatMap((v) => v.split(',')).map((v) => v.trim().toLowerCase()).filter(Boolean)),
  );
}

export async function GET(req: NextRequest) {
  const auth = await getSupabase(req);
  if ('error' in auth) return auth.error;
  const { supabase, user } = auth;
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();

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
  const limit = Math.min(100_000, Math.max(1, Number(sp.get('limit') ?? '100')));
  const offset = Math.max(0, Number(sp.get('offset') ?? '0'));

  // No COUNT(*) here — the "≈ N" counter uses the instant planner estimate
  // (/api/funded/count); export loops until a page returns fewer than `limit`.
  let query = supabase.from('funded_companies').select('*');
  if (source.length) query = query.in('source', source);
  if (country.length) query = query.in('country', country);
  if (industry.length) query = query.in('industry', industry);
  if (stage.length) query = query.in('last_funding_type', stage);
  if (hasFunding) {
    query = query.or('last_funding_date.not.is.null,last_funding_usd.not.is.null,total_funding_usd.not.is.null');
  }
  if (minFunding != null) {
    query = query.or(`last_funding_usd.gte.${minFunding},total_funding_usd.gte.${minFunding}`);
  }
  if (fundedSince) query = query.gte('last_funding_date', fundedSince);
  if (name) query = query.ilike('name', `%${name.replace(/[%_]/g, '')}%`);

  // Most-recently-funded first (the outreach-trigger view), then name for stability.
  query = query
    .order('last_funding_date', { ascending: false, nullsFirst: false })
    .order('name', { ascending: true })
    .range(offset, offset + limit - 1);

  const { data, error } = await query;
  if (error) {
    await logError('funded.search.failed', error, { source, country, industry, stage, name }, { userId: user.id });
    return jsonError(error.message, 500, { request_id: requestId });
  }
  return NextResponse.json({ items: data ?? [], limit, offset });
}

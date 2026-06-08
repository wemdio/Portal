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
  const out = sp
    .getAll(key)
    .flatMap((v) => v.split(','))
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set(out));
}

export async function GET(req: NextRequest) {
  const auth = await getSupabase(req);
  if ('error' in auth) return auth.error;
  const { supabase, user } = auth;
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();

  const sp = req.nextUrl.searchParams;
  const industry = listParam(sp, 'industry');
  const size = listParam(sp, 'size');
  const country = listParam(sp, 'country');
  const name = (sp.get('name') ?? '').trim();
  const limit = Math.min(1000, Math.max(1, Number(sp.get('limit') ?? '200')));
  const offset = Math.max(0, Number(sp.get('offset') ?? '0'));

  let query = supabase.from('pdl_companies').select('*', { count: 'exact' });
  if (country.length) query = query.in('country', country);
  if (industry.length) query = query.in('industry', industry);
  if (size.length) query = query.in('size', size);
  if (name) query = query.ilike('name', `%${name.replace(/[%_]/g, '')}%`);
  query = query.order('name', { ascending: true }).range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) {
    await logError('company_base.search.failed', error, { industry, size, country, name }, { userId: user.id });
    return jsonError(error.message, 500, { request_id: requestId });
  }
  return NextResponse.json({ items: data ?? [], count: count ?? 0, limit, offset });
}

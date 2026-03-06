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
  if (!token) return { error: jsonError('Unauthorized', 401, { request_id: req.headers.get('x-request-id') ?? null }) };

  const supabase = createAuthedSupabaseClient(token);
  const requestId = req.headers.get('x-request-id') ?? null;
  const route = req.nextUrl.pathname;
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const logMeta = { requestId, route, ip };

  try {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) {
      await logError('parser.hh.auth.failed', error ?? 'User not found', { hasUser: Boolean(data?.user) }, logMeta);
      return { error: jsonError('Unauthorized', 401, { request_id: requestId }) };
    }
    return { supabase, user: data.user };
  } catch (err) {
    await logError('parser.hh.auth.exception', err, undefined, logMeta);
    return { error: jsonError('Unauthorized', 401, { request_id: requestId }) };
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const auth = await getSupabase(req);
  if ('error' in auth) return auth.error;

  const { supabase, user } = auth;
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const route = req.nextUrl.pathname;
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const logMeta = { userId: user.id, requestId, route, ip };
  const { jobId } = await ctx.params;

  const sp = req.nextUrl.searchParams;
  const limit = Math.min(1000, Math.max(1, Number(sp.get('limit') ?? '50')));
  const offset = Math.max(0, Number(sp.get('offset') ?? '0'));

  const { data, error, count } = await supabase
    .from('hh_vacancies')
    .select('*', { count: 'exact' })
    .eq('job_id', jobId)
    .order('published_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    await logError('parser.hh.results.fetch.failed', error, { jobId, limit, offset }, logMeta);
    return jsonError(error.message, 500, { request_id: requestId });
  }
  return NextResponse.json({ items: data ?? [], count: count ?? 0, limit, offset });
}


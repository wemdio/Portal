import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

async function getSupabase(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { error: jsonError('Unauthorized', 401) };

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: jsonError('Unauthorized', 401) };

  return { supabase, user };
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
  const limit = Math.min(200, Math.max(1, Number(sp.get('limit') ?? '50')));
  const offset = Math.max(0, Number(sp.get('offset') ?? '0'));

  const { data, error, count } = await supabase
    .from('hh_vacancies')
    .select('*', { count: 'exact' })
    .eq('job_id', jobId)
    .order('published_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    await logError('parser.hh.results.fetch.failed', error, { jobId, limit, offset }, logMeta);
    return jsonError(error.message, 500);
  }
  return NextResponse.json({ items: data ?? [], count: count ?? 0, limit, offset });
}


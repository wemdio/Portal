import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function getJobIdFromUrl(req: NextRequest) {
  const parts = req.nextUrl.pathname.split('/').filter(Boolean);
  return parts[parts.length - 2] ?? '';
}

export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const jobId = getJobIdFromUrl(req);
  const limit = Math.max(1, Math.min(5000, Number(req.nextUrl.searchParams.get('limit') ?? '200') || 200));
  const offset = Math.max(0, Number(req.nextUrl.searchParams.get('offset') ?? '0') || 0);

  const { data, error } = await supabase
    .from('yandex_maps_organizations')
    .select('*')
    .eq('job_id', jobId)
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ results: data ?? [], limit, offset, hasMore: (data?.length ?? 0) === limit });
}


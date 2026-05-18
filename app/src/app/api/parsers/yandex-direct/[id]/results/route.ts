/**
 * GET /api/parsers/yandex-direct/[id]/results?limit=&offset=
 *
 * Пагинированная выгрузка yandex_direct_results. RLS отсекает чужие job'ы.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

export const dynamic = 'force-dynamic';

function err(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return err('Unauthorized', 401);
  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return err('Unauthorized', 401);

  const { id } = await params;
  const url = new URL(req.url);
  const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get('limit') ?? '500')));
  const offset = Math.max(0, Number(url.searchParams.get('offset') ?? '0'));

  // Проверяем, что job наш (RLS отсечёт чужой).
  const { data: job, error: jobErr } = await supabase
    .from('yandex_direct_jobs')
    .select('id')
    .eq('id', id)
    .maybeSingle();
  if (jobErr) return err(jobErr.message, 500);
  if (!job) return err('Not found', 404);

  const { data, error, count } = await supabase
    .from('yandex_direct_results')
    .select('niche, domain, title, ad_text, url, region, keyword, block, source', {
      count: 'exact',
    })
    .eq('job_id', id)
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) return err(error.message, 500);

  return NextResponse.json({
    results: data ?? [],
    total: count ?? 0,
    limit,
    offset,
  });
}

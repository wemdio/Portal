import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import {
  fetchOrganizationPage,
  fetchOrganizationsWithoutCard,
  ORGANIZATIONS_PAGE,
} from '@/lib/yandexmaps/organizationPages';

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
  const limit = Math.max(1, Math.min(ORGANIZATIONS_PAGE, Number(req.nextUrl.searchParams.get('limit') ?? '200') || 200));

  // Страницы по курсору card_url, а не offset: см. lib/yandexmaps/organizationPages.
  // ?after=<card_url> — следующая страница; после последней клиент берёт
  // ?nocard=1 — строки без card_url.
  try {
    if (req.nextUrl.searchParams.get('nocard') === '1') {
      const results = await fetchOrganizationsWithoutCard(supabase, jobId);
      return NextResponse.json({ results, nextAfter: null, hasMore: false });
    }
    const after = req.nextUrl.searchParams.get('after');
    const page = await fetchOrganizationPage(supabase, jobId, after || null, limit);
    return NextResponse.json({ results: page.rows, nextAfter: page.nextAfter, hasMore: page.nextAfter !== null });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : 'Не удалось прочитать результаты', 500);
  }
}

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { logError } from '@/lib/loggerServer';
import { POLZA_FUNNEL_COLUMNS, polzaFunnel, type PolzaFunnelRow } from '@/lib/polzaOutreach/funnel';
import { POLZA_RESULTS_MAX_PAGE } from '@/lib/polzaOutreach/resultsPaging';

export const dynamic = 'force-dynamic';

type SummaryRow = PolzaFunnelRow & { exclusion_reason: string | null };

function jsonError(message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...(extra ?? {}) }, { status });
}async function getSupabase(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { error: jsonError('Unauthorized', 401, { request_id: req.headers.get('x-request-id') ?? null }) };

  const supabase = createAuthedSupabaseClient(token);
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) return { error: jsonError('Unauthorized', 401) };
    return { supabase, user: data.user };
  } catch {
    return { error: jsonError('Unauthorized', 401) };
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const auth = await getSupabase(req);
  if ('error' in auth) return auth.error;

  const { supabase, user } = auth;
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const logMeta = { userId: user.id, requestId, route: req.nextUrl.pathname };
  const { jobId } = await ctx.params;

  const sp = req.nextUrl.searchParams;
  // Мусор в параметрах — значения по умолчанию, а не NaN в range().
  const limit = Math.min(POLZA_RESULTS_MAX_PAGE, Math.max(1, Math.trunc(Number(sp.get('limit') ?? '50')) || 50));
  const offset = Math.max(0, Math.trunc(Number(sp.get('offset') ?? '0')) || 0);
  const statusFilter = sp.get('status');

  // Порядок стабильный: строки одной вставки делят created_at, и без id
  // соседние страницы (окно этапа и выгрузка читают прогон целиком) могли бы
  // повторять одни строки и терять другие.
  let resultsQuery = supabase
    .from('polza_outreach_companies')
    .select('*', { count: 'exact' })
    .eq('job_id', jobId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1);
  if (statusFilter) resultsQuery = resultsQuery.eq('status', statusFilter);

  const { data, error, count } = await resultsQuery;
  if (error) {
    await logError('parser.polza_outreach.results.fetch.failed', error, { jobId, limit, offset }, logMeta);
    return jsonError(error.message, 500, { request_id: requestId });
  }

  // Воронка и сводка — по всем строкам джобы, независимо от пагинации.
  const statusCounts = {} as Record<string, number>;
  const exclusionCounts = {} as Record<string, number>;
  // Почему строки ждут ручной проверки — экран показывает «почта не проверена — N».
  const reviewCounts = {} as Record<string, number>;

  // Одна выборка всех строк дешевле head-запроса на каждый этап. Страницами
  // по 1000, как соседние роуты: запуск на 500 готовых просматривает до 4000
  // кандидатов, а выдачу PostgREST может ограничивать max-rows — без страниц
  // воронка молча обрезалась бы.
  const allRows: SummaryRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data: chunk, error: allErr } = await supabase
      .from('polza_outreach_companies')
      .select(`${POLZA_FUNNEL_COLUMNS},exclusion_reason`)
      .eq('job_id', jobId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (allErr) {
      await logError('parser.polza_outreach.summary.fetch.failed', allErr, { jobId }, logMeta);
      return jsonError(allErr.message, 500, { request_id: requestId });
    }
    allRows.push(...((chunk ?? []) as unknown as SummaryRow[]));
    if (!chunk || chunk.length < PAGE) break;
  }

  // Правила этапов общие с окном разбора этапа на экране (lib/polzaOutreach/funnel.ts).
  const funnel = polzaFunnel(allRows);
  for (const row of allRows) {
    statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
    if (row.status === 'excluded' && row.exclusion_reason) {
      exclusionCounts[row.exclusion_reason] = (exclusionCounts[row.exclusion_reason] ?? 0) + 1;
    }
    if (row.status === 'needs_review' && row.review_reason) {
      reviewCounts[row.review_reason] = (reviewCounts[row.review_reason] ?? 0) + 1;
    }
  }

  return NextResponse.json({
    items: data ?? [],
    count: count ?? 0,
    limit,
    offset,
    funnel,
    status_counts: statusCounts,
    exclusion_counts: exclusionCounts,
    review_counts: reviewCounts,
  });
}

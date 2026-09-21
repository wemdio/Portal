import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

const STAGE_ICP_PASSED = ['s4_analyzed', 's5_email', 's6_letters'];

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
  const limit = Math.min(1000, Math.max(1, Number(sp.get('limit') ?? '50')));
  const offset = Math.max(0, Number(sp.get('offset') ?? '0'));
  const statusFilter = sp.get('status');

  let resultsQuery = supabase
    .from('polza_outreach_companies')
    .select('*', { count: 'exact' })
    .eq('job_id', jobId)
    .order('created_at', { ascending: true })
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

  // Одна выборка всех строк дешевле восьми head-запросов: строк ≤ 300 на джобу.
  const { data: allRows, error: allErr } = await supabase
    .from('polza_outreach_companies')
    .select('status,stage,exclusion_reason,normalized_domain,selected_company_email,target_sales_geo_confidence')
    .eq('job_id', jobId);
  if (allErr) {
    await logError('parser.polza_outreach.summary.fetch.failed', allErr, { jobId }, logMeta);
    return jsonError(allErr.message, 500, { request_id: requestId });
  }

  const funnel = {
    vacancies: allRows?.length ?? 0,
    domain_found: allRows?.filter((r) => r.normalized_domain).length ?? 0,
    icp_passed: allRows?.filter((r) => STAGE_ICP_PASSED.includes(String(r.stage))).length ?? 0,
    geo_confirmed:
      allRows?.filter(
        (r) => r.target_sales_geo_confidence === 'high' || r.target_sales_geo_confidence === 'medium',
      ).length ?? 0,
    email_found: allRows?.filter((r) => r.selected_company_email).length ?? 0,
    ready: allRows?.filter((r) => r.status === 'ready').length ?? 0,
  };
  for (const row of allRows ?? []) {
    statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
    if (row.status === 'excluded' && row.exclusion_reason) {
      exclusionCounts[row.exclusion_reason] = (exclusionCounts[row.exclusion_reason] ?? 0) + 1;
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
  });
}

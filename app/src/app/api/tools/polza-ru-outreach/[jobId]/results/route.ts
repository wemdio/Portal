import { NextResponse, type NextRequest } from 'next/server';
import { logError } from '@/lib/loggerServer';
import { funnelFromRows } from '@/lib/polzaRuOutreach/funnel';
import { authed, jsonError } from '@/lib/polzaRuOutreach/routeAuth';

export const dynamic = 'force-dynamic';

const LIST_COLUMNS =
  'id,chain_type,source_type,source_url,source_urls,company_name,company_brand,inn,normalized_domain,company_website,' +
  'prior_contact,prior_contact_date,amo_status,ta_score,ta_reason,priority_score,case_match_reason,campaign_hypothesis,email_verification,signal_type,signal_date,signal_title,evidence_quote,evidence_level,market_evidence_quote,' +
  'target_market,signals,fit_reasons,signal_score,generation_mode,recipient_email,email_type,recipient_role,is_routing,' +
  'letters,subject_b,case_id,offer_version,template_version,qa_status,qa_flags,row_status,pipeline_stage,reason_code,reason_detail,' +
  'doubt_flags,doubt_detail,route_reason,route_runner_up,created_at';

/**
 * Строки журнала запуска + воронка по этапам и причины отсева.
 * Воронка считается по всем строкам — правило в lib/polzaRuOutreach/funnel.ts
 * (им же раннер пересчитывает счётчики по журналу).
 *
 * Порядок страниц — created_at, при равенстве id: раннер вставляет строки
 * пачками по 100 с одним created_at, и без второго ключа соседние страницы
 * могли бы повторить или пропустить строки.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const auth = await authed(req);
  if ('error' in auth) return auth.error;
  const { jobId } = await ctx.params;
  const sp = req.nextUrl.searchParams;
  const limit = Math.min(500, Math.max(1, Number(sp.get('limit') ?? '50')));
  const offset = Math.max(0, Number(sp.get('offset') ?? '0'));
  const status = sp.get('status');
  const stage = sp.get('stage');
  const reason = sp.get('reason');

  let query = auth.supabase
    .from('polza_ru_outreach_companies')
    .select(LIST_COLUMNS, { count: 'exact' })
    .eq('job_id', jobId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1);
  if (status) query = query.eq('row_status', status);
  if (stage) query = query.eq('pipeline_stage', stage);
  if (reason) query = query.eq('reason_code', reason);
  const { data, error, count } = await query;
  if (error) {
    await logError('polza_ru_outreach.results.failed', error, { jobId }, { userId: auth.user.id });
    return jsonError(error.message, 500);
  }

  const all: Array<{ row_status: string; pipeline_stage: string | null; reason_code: string | null }> = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data: chunk, error: allErr } = await auth.supabase
      .from('polza_ru_outreach_companies')
      .select('row_status,pipeline_stage,reason_code')
      .eq('job_id', jobId)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (allErr) return jsonError(allErr.message, 500);
    all.push(...((chunk ?? []) as typeof all));
    if (!chunk || chunk.length < PAGE) break;
  }

  const funnel = funnelFromRows(all);
  const statusCounts: Record<string, number> = {};
  const reasonCounts: Record<string, number> = {};
  for (const row of all) {
    statusCounts[row.row_status] = (statusCounts[row.row_status] ?? 0) + 1;
    if (row.reason_code) reasonCounts[row.reason_code] = (reasonCounts[row.reason_code] ?? 0) + 1;
  }

  return NextResponse.json({ items: data ?? [], count: count ?? 0, limit, offset, funnel, status_counts: statusCounts, reason_counts: reasonCounts });
}

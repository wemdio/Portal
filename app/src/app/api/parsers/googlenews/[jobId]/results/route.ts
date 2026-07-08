import { NextResponse, type NextRequest } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/parsers/googleParsersRouteAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const auth = await authenticateRequest(req);
  if (auth.error) return auth.error;
  const { supabase } = auth;

  if (!supabaseAdmin) return jsonError('Service unavailable', 503);

  const { jobId } = await ctx.params;

  const limit = Math.max(
    1,
    Math.min(5000, Number(req.nextUrl.searchParams.get('limit') ?? '5000') || 5000),
  );
  const offset = Math.max(0, Number(req.nextUrl.searchParams.get('offset') ?? '0') || 0);

  // Ownership check respects RLS (auth'd client).
  const { data: job, error: jobError } = await supabase
    .from('google_news_jobs')
    .select('id')
    .eq('id', jobId)
    .maybeSingle();
  if (jobError) return jsonError(jobError.message, 500);
  if (!job) return jsonError('Not found', 404);

  const { data, error } = await supabaseAdmin
    .from('google_news_results')
    .select('*')
    .eq('job_id', jobId)
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) return jsonError(error.message, 500);

  const results = data ?? [];
  return NextResponse.json({
    results,
    limit,
    offset,
    hasMore: results.length === limit,
  });
}

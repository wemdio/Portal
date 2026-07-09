import { NextResponse, type NextRequest } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/parsers/googleParsersRouteAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export type GoogleParserLogRow = {
  id: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  meta: unknown;
  created_at: string;
};

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const DEFAULT_SINCE_MS = 24 * 60 * 60 * 1000; // 24h

export async function GET(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const auth = await authenticateRequest(req);
  if (auth.error) return auth.error;
  const { supabase } = auth;

  if (!supabaseAdmin) return jsonError('Service unavailable', 503);

  const { jobId } = await ctx.params;

  const rawLimit = Number(req.nextUrl.searchParams.get('limit') ?? String(DEFAULT_LIMIT));
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(rawLimit) ? rawLimit : DEFAULT_LIMIT));

  const sinceParam = req.nextUrl.searchParams.get('since');
  const sinceIso = sinceParam
    ? new Date(sinceParam).toISOString()
    : new Date(Date.now() - DEFAULT_SINCE_MS).toISOString();

  // Ownership check via authed client — respects RLS on google_news_jobs.
  const { data: job, error: jobError } = await supabase
    .from('google_news_jobs')
    .select('id')
    .eq('id', jobId)
    .maybeSingle();
  if (jobError) return jsonError(jobError.message, 500);
  if (!job) return jsonError('Not found', 404);

  const { data, error } = await supabaseAdmin
    .from('google_parsers_logs')
    .select('id, level, message, meta, created_at')
    .eq('job_id', jobId)
    .eq('job_kind', 'news')
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) return jsonError(error.message, 500);

  return NextResponse.json({ logs: (data ?? []) as GoogleParserLogRow[] });
}

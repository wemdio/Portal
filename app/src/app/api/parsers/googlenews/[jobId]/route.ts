import { NextResponse, type NextRequest } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/parsers/googleParsersRouteAuth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const auth = await authenticateRequest(req);
  if (auth.error) return auth.error;
  const { supabase } = auth;

  const { jobId } = await ctx.params;

  const { data: job, error } = await supabase
    .from('google_news_jobs')
    .select('*')
    .eq('id', jobId)
    .maybeSingle();

  if (error) return jsonError(error.message, 500);
  if (!job) return jsonError('Not found', 404);
  return NextResponse.json({ job });
}

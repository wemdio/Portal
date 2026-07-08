import { NextResponse, type NextRequest } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/parsers/googleParsersRouteAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const auth = await authenticateRequest(req);
  if (auth.error) return auth.error;
  const { user } = auth;

  if (!supabaseAdmin) return jsonError('Service unavailable', 503);

  const { jobId } = await ctx.params;

  const { data, error } = await supabaseAdmin
    .from('google_maps_jobs')
    .update({ status: 'paused' })
    .eq('id', jobId)
    .eq('user_id', user.id)
    .in('status', ['running', 'queued'])
    .select('*')
    .maybeSingle();

  if (error) return jsonError(error.message, 500);
  if (!data) return jsonError('cannot pause in current state', 409);
  return NextResponse.json({ job: data });
}

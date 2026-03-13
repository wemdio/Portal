import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const { jobId } = await params;

  // Verify job belongs to user
  const { data: job, error: jobError } = await supabase
    .from('lpr_jobs')
    .select('id')
    .eq('id', jobId)
    .eq('user_id', user.id)
    .single();

  if (jobError || !job) return jsonError('Job not found', 404);

  const { data: candidates, error } = await supabase
    .from('lpr_candidates')
    .select('*')
    .eq('job_id', jobId)
    .order('score', { ascending: false });

  if (error) return jsonError(error.message, 500);

  return NextResponse.json({ candidates: candidates ?? [] });
}

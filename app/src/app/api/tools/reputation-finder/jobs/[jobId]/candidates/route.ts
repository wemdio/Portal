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
  const { searchParams } = req.nextUrl;
  const classification = searchParams.get('classification');
  const limit = Math.min(Number(searchParams.get('limit') ?? '200'), 500);

  let query = supabase
    .from('reputation_candidates')
    .select('*')
    .eq('job_id', jobId)
    .order('pain_score', { ascending: false })
    .limit(limit);

  if (classification) {
    query = query.eq('classification', classification);
  }

  const { data, error } = await query;
  if (error) return jsonError(error.message, 500);

  return NextResponse.json({ candidates: data ?? [] });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const { jobId } = await params;
  const body = await req.json().catch(() => null);
  if (!body) return jsonError('Invalid JSON body', 400);

  const { candidateId, decision } = body;
  if (!candidateId || !['accept', 'reject'].includes(decision)) {
    return jsonError('candidateId and decision (accept|reject) required', 400);
  }

  const { error } = await supabase
    .from('reputation_candidates')
    .update({
      review_decision: decision,
      reviewed_at: new Date().toISOString(),
      classification: decision === 'accept' ? 'auto_export' : 'discard',
    })
    .eq('id', candidateId)
    .eq('job_id', jobId);

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ ok: true });
}

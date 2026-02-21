import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const { data: job, error } = await supabase
    .from('email_validation_jobs')
    .select('id, status, total, processed, success_count, error_count, error_message, created_at, completed_at')
    .eq('id', jobId)
    .eq('user_id', user.id)
    .single();

  if (error || !job) return jsonError('Job not found', 404);
  return NextResponse.json({ job });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  let body: { action?: string };
  try { body = (await req.json()) as { action?: string }; }
  catch { return jsonError('Invalid JSON body', 400); }

  if (body.action === 'cancel') {
    const { error } = await supabaseAdmin
      .from('email_validation_jobs')
      .update({ status: 'cancelled', completed_at: new Date().toISOString() })
      .eq('id', jobId)
      .eq('user_id', user.id)
      .in('status', ['pending', 'running']);

    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ ok: true });
  }

  return jsonError('Unknown action', 400);
}

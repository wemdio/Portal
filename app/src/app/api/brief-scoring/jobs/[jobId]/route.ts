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
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const { data: job, error } = await supabase
    .from('brief_scoring_jobs')
    .select('id, status, total, processed, success_count, error_count, error_message, created_at, started_at, completed_at')
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
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  let body: { action?: string };
  try {
    body = (await req.json()) as { action?: string };
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  if (body.action === 'cancel') {
    const now = new Date().toISOString();

    const { error } = await supabaseAdmin
      .from('brief_scoring_jobs')
      .update({
        status: 'cancelled',
        completed_at: now,
        error_message: 'Операция отменена пользователем',
      })
      .eq('id', jobId)
      .eq('user_id', user.id)
      .in('status', ['pending', 'running']);

    if (error) return jsonError(error.message, 500);

    await supabaseAdmin
      .from('brief_scoring_queue')
      .update({
        status: 'failed',
        score: null,
        reason: null,
        last_error: 'Операция отменена пользователем',
        updated_at: now,
        completed_at: now,
      })
      .eq('job_id', jobId)
      .eq('user_id', user.id)
      .in('status', ['pending', 'processing']);

    return NextResponse.json({ ok: true });
  }

  return jsonError('Unknown action', 400);
}


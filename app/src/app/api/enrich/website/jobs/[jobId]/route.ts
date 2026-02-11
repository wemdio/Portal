import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    const token = getBearerToken(req.headers.get('authorization'));
    if (!token) return jsonError('Unauthorized', 401);

    const supabase = createAuthedSupabaseClient(token);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return jsonError('Unauthorized', 401);

    const { data: job, error } = await supabase
      .from('website_enrichment_jobs')
      .select('*')
      .eq('id', jobId)
      .eq('user_id', user.id)
      .single();

    if (error || !job) return jsonError('Job not found', 404);
    return NextResponse.json({ job });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : 'Internal error', 500);
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    const token = getBearerToken(req.headers.get('authorization'));
    if (!token) return jsonError('Unauthorized', 401);
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

    const supabase = createAuthedSupabaseClient(token);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return jsonError('Unauthorized', 401);

    let body: { status?: string };
    try {
      body = (await req.json()) as { status?: string };
    } catch {
      body = {};
    }

    if (body.status !== 'cancelled') {
      return jsonError('Unsupported action', 400);
    }

    const { data: job, error: jobError } = await supabase
      .from('website_enrichment_jobs')
      .select('id')
      .eq('id', jobId)
      .eq('user_id', user.id)
      .single();

    if (jobError || !job) return jsonError('Job not found', 404);

    const cancelledAt = new Date().toISOString();
    const stopReason = 'Операция отменена пользователем';

    const { error } = await supabaseAdmin
      .from('website_enrichment_jobs')
      .update({
        status: 'cancelled',
        completed_at: cancelledAt,
        error_message: stopReason,
      })
      .eq('id', jobId);

    if (error) return jsonError(error.message, 500);

    const { error: queueError } = await supabaseAdmin
      .from('website_enrichment_queue')
      .update({
        status: 'failed',
        result_text: null,
        last_error: stopReason,
        updated_at: cancelledAt,
        completed_at: cancelledAt,
      })
      .eq('job_id', jobId)
      .in('status', ['pending', 'processing']);

    if (queueError) return jsonError(queueError.message, 500);

    return NextResponse.json({ status: 'cancelled' });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : 'Internal error', 500);
  }
}

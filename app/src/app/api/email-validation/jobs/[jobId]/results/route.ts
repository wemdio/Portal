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
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

    const supabase = createAuthedSupabaseClient(token);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return jsonError('Unauthorized', 401);

    const url = new URL(req.url);
    const cursor = url.searchParams.get('cursor');
    const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get('limit') ?? '500')));

    const { data: job, error: jobError } = await supabase
      .from('email_validation_jobs')
      .select('id, status, total, processed, success_count, error_count, error_message')
      .eq('id', jobId)
      .eq('user_id', user.id)
      .single();

    if (jobError || !job) return jsonError('Job not found', 404);

    let query = supabaseAdmin
      .from('email_validation_queue')
      .select('id, row_index, email_normalized, result, quality, is_free, is_role, is_disposable, is_catch_all, did_you_mean, mx_found, smtp_code, status, last_error, updated_at')
      .eq('job_id', jobId)
      .in('status', ['completed', 'failed'])
      .order('updated_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(limit);

    if (cursor) {
      const [cursorTime, cursorId] = cursor.split('|');
      if (cursorTime && cursorId) {
        query = query.or(
          `updated_at.gt.${cursorTime},and(updated_at.eq.${cursorTime},id.gt.${cursorId})`,
        );
      } else {
        query = query.gt('updated_at', cursor);
      }
    }

    const { data: results, error } = await query;
    if (error) return jsonError(error.message, 500);

    const nextCursor = results && results.length > 0
      ? `${results[results.length - 1]?.updated_at ?? ''}|${results[results.length - 1]?.id ?? ''}`
      : cursor;

    return NextResponse.json({ job, results: results ?? [], next_cursor: nextCursor });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : 'Internal error', 500);
  }
}

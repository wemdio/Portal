import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { logAudit, logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...(extra ?? {}) }, { status });
}

async function getSupabase(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { error: jsonError('Unauthorized', 401, { request_id: req.headers.get('x-request-id') ?? null }) };

  const supabase = createAuthedSupabaseClient(token);
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) return { error: jsonError('Unauthorized', 401) };
    return { supabase, user: data.user };
  } catch {
    return { error: jsonError('Unauthorized', 401) };
  }
}

// Stop a running/pending job (best-effort): the runner notices the status change
// at its next checkpoint and aborts.
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const auth = await getSupabase(req);
  if ('error' in auth) return auth.error;
  const { supabase, user } = auth;
  const { jobId } = await ctx.params;

  let body: { action?: string } = {};
  try {
    body = (await req.json()) as { action?: string };
  } catch {
    /* empty body is fine */
  }
  if (body.action !== 'stop') {
    return jsonError('Unsupported action', 400);
  }

  const { error } = await supabase
    .from('parser_jobs')
    .update({
      status: 'failed',
      progress_stage: 'failed',
      error_message: 'Остановлено пользователем',
      completed_at: new Date().toISOString(),
    })
    .eq('id', jobId)
    .in('status', ['pending', 'running']);

  if (error) {
    await logError('parser.ats.job.stop.failed', error, { jobId }, { userId: user.id });
    return jsonError(error.message, 500);
  }
  await logAudit('parser.ats.job.stopped', 'ATS parser job stopped', { jobId }, { userId: user.id });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const auth = await getSupabase(req);
  if ('error' in auth) return auth.error;
  const { supabase, user } = auth;
  const { jobId } = await ctx.params;

  // ON DELETE CASCADE on ats_companies.job_id removes results too.
  const { error } = await supabase.from('parser_jobs').delete().eq('id', jobId);
  if (error) {
    await logError('parser.ats.job.delete.failed', error, { jobId }, { userId: user.id });
    return jsonError(error.message, 500);
  }
  await logAudit('parser.ats.job.deleted', 'ATS parser job deleted', { jobId }, { userId: user.id });
  return NextResponse.json({ ok: true });
}

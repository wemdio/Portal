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
      error_message: 'Stopped by user',
      completed_at: new Date().toISOString(),
    })
    .eq('id', jobId)
    .eq('parser_type', 'eng_hiring')
    .in('status', ['pending', 'running']);

  if (error) {
    await logError('parser.eng_hiring.job.stop.failed', error, { jobId }, { userId: user.id });
    return jsonError(error.message, 500);
  }
  await logAudit('parser.eng_hiring.job.stopped', 'ENG hiring parser job stopped', { jobId }, { userId: user.id });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const auth = await getSupabase(req);
  if ('error' in auth) return auth.error;
  const { supabase, user } = auth;
  const { jobId } = await ctx.params;

  const { error } = await supabase.from('parser_jobs').delete().eq('id', jobId).eq('parser_type', 'eng_hiring');
  if (error) {
    await logError('parser.eng_hiring.job.delete.failed', error, { jobId }, { userId: user.id });
    return jsonError(error.message, 500);
  }
  await logAudit('parser.eng_hiring.job.deleted', 'ENG hiring parser job deleted', { jobId }, { userId: user.id });
  return NextResponse.json({ ok: true });
}

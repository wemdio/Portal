import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { logAudit, logError } from '@/lib/loggerServer';
import { jobHasSenderUploads, UPLOADED_JOB_DELETE_MESSAGE } from '@/lib/outreachSender/deletion';

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
    .eq('parser_type', 'polza_outreach')
    .in('status', ['pending', 'running']);

  if (error) {
    await logError('parser.polza_outreach.job.stop.failed', error, { jobId }, { userId: user.id });
    return jsonError(error.message, 500);
  }
  await logAudit('parser.polza_outreach.job.stopped', 'Polza outreach parser job stopped', { jobId }, { userId: user.id });
  return NextResponse.json({ ok: true });
}

/**
 * Удаление запуска вместе с журналом. Запуск, залитый в «Рассылку», не
 * удаляется: его строки — память о том, что компаниям уже писали
 * (outreachSender/deletion.ts), без неё следующий запуск нашёл бы их снова.
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const auth = await getSupabase(req);
  if ('error' in auth) return auth.error;
  const { supabase, user } = auth;
  const { jobId } = await ctx.params;

  try {
    if (await jobHasSenderUploads(supabase, 'en', jobId)) return jsonError(UPLOADED_JOB_DELETE_MESSAGE, 409);
  } catch (e) {
    await logError('parser.polza_outreach.job.delete.failed', e, { jobId }, { userId: user.id });
    return jsonError(e instanceof Error ? e.message : 'Не удалось проверить запуск', 500);
  }

  const { error } = await supabase.from('parser_jobs').delete().eq('id', jobId).eq('parser_type', 'polza_outreach');
  if (error) {
    await logError('parser.polza_outreach.job.delete.failed', error, { jobId }, { userId: user.id });
    return jsonError(error.message, 500);
  }
  await logAudit('parser.polza_outreach.job.deleted', 'Polza outreach parser job deleted', { jobId }, { userId: user.id });
  return NextResponse.json({ ok: true });
}

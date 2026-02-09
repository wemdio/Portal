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
  const requestId = req.headers.get('x-request-id') ?? null;
  const route = req.nextUrl.pathname;
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const logMeta = { requestId, route, ip };

  try {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) {
      await logError('parser.hh.auth.failed', error ?? 'User not found', { hasUser: Boolean(data?.user) }, logMeta);
      return { error: jsonError('Unauthorized', 401, { request_id: requestId }) };
    }
    return { supabase, user: data.user };
  } catch (err) {
    await logError('parser.hh.auth.exception', err, undefined, logMeta);
    return { error: jsonError('Unauthorized', 401, { request_id: requestId }) };
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const auth = await getSupabase(req);
  if ('error' in auth) return auth.error;

  const { supabase, user } = auth;
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const route = req.nextUrl.pathname;
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const logMeta = { userId: user.id, requestId, route, ip };
  const { jobId } = await ctx.params;

  const { data, error } = await supabase
    .from('parser_jobs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (error) {
    await logError('parser.hh.job.fetch.failed', error, { jobId }, logMeta);
    return jsonError(error.message, 404, { request_id: requestId });
  }
  return NextResponse.json({ job: data });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const auth = await getSupabase(req);
  if ('error' in auth) return auth.error;

  const { supabase, user } = auth;
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const route = req.nextUrl.pathname;
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const logMeta = { userId: user.id, requestId, route, ip };

  let body: { action?: string };
  try {
    body = (await req.json()) as { action?: string };
  } catch {
    return jsonError('Invalid JSON body', 400, { request_id: requestId });
  }

  const { jobId } = await ctx.params;
  if (body.action !== 'stop') return jsonError('Unsupported action', 400, { request_id: requestId });

  const { data, error } = await supabase
    .from('parser_jobs')
    .update({
      status: 'failed',
      completed_at: new Date().toISOString(),
      error_message: 'Остановлено пользователем',
      progress_stage: 'cancelled',
    })
    .eq('id', jobId)
    .eq('user_id', user.id)
    .select('id, status, error_message')
    .single();

  if (error || !data) {
    await logError('parser.hh.job.stop.failed', error ?? 'Job not found', { jobId }, logMeta);
    return jsonError(error?.message ?? 'Job not found', 404, { request_id: requestId });
  }

  await logAudit('parser.hh.job.stopped', 'HH parser job stopped', { jobId }, logMeta);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const auth = await getSupabase(req);
  if ('error' in auth) return auth.error;

  const { supabase, user } = auth;
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const route = req.nextUrl.pathname;
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const logMeta = { userId: user.id, requestId, route, ip };
  const { jobId } = await ctx.params;

  const { error } = await supabase
    .from('parser_jobs')
    .delete()
    .eq('id', jobId)
    .eq('user_id', user.id);

  if (error) {
    await logError('parser.hh.job.delete.failed', error, { jobId }, logMeta);
    return jsonError(error.message, 500, { request_id: requestId });
  }

  await logAudit('parser.hh.job.deleted', 'HH parser job deleted', { jobId }, logMeta);
  return NextResponse.json({ ok: true });
}


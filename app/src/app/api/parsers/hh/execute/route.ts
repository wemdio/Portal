import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { logAudit } from '@/lib/loggerServer';
import { blockDemo } from '@/lib/auth/blockDemo';

export const dynamic = 'force-dynamic';

const PARSER_TYPE = 'hh_vacancies' as const;

function jsonError(message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...(extra ?? {}) }, { status });
}

export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const route = req.nextUrl.pathname;
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return jsonError('Unauthorized', 401, { request_id: requestId });

  const demo = await blockDemo(supabase, user.id);
  if (demo) return demo;

  const logMeta = { userId: user.id, requestId, route, ip };

  let body: { job_id?: string };
  try {
    body = (await req.json()) as { job_id?: string };
  } catch {
    return jsonError('Invalid JSON body', 400, { request_id: requestId });
  }

  const jobId = body.job_id;
  if (!jobId) return jsonError('Missing required field: job_id', 400, { request_id: requestId });

  const { data: job, error: jobError } = await supabase
    .from('parser_jobs')
    .select('id, status, parser_type')
    .eq('id', jobId)
    .eq('user_id', user.id)
    .single();

  if (jobError || !job) return jsonError('Job not found', 404, { request_id: requestId });
  if (job.parser_type !== PARSER_TYPE) return jsonError('Unsupported parser_type', 400, { request_id: requestId });
  if (job.status === 'running') return jsonError('Job is already running', 409, { request_id: requestId });
  if (job.status === 'completed') return jsonError('Job already completed', 409, { request_id: requestId });

  // Reset failed/cancelled jobs to pending so the worker picks them up
  if (job.status === 'failed' || job.status === 'cancelled') {
    await supabase
      .from('parser_jobs')
      .update({ status: 'pending', error_message: null, progress_percent: 0, progress_stage: 'pending' })
      .eq('id', jobId);
  }

  await logAudit('parser.hh.execute.queued', 'HH parser job queued for worker', { jobId }, logMeta);

  return NextResponse.json({ status: 'queued', job_id: jobId }, { status: 202 });
}

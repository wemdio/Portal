import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { logAudit, logError, logInfo } from '@/lib/loggerServer';
import { fetchVacancies, HHApiError } from '@/lib/parsers/hhParser';
import type { HHSearchConfig, HHVacancy } from '@/lib/parsers/hhParser';

export const dynamic = 'force-dynamic';

const PARSER_TYPE = 'hh_vacancies' as const;

function jsonError(message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...(extra ?? {}) }, { status });
}

async function getSupabase(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { error: jsonError('Unauthorized', 401) };

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: jsonError('Unauthorized', 401) };

  return { supabase, user };
}

function toDbRow(jobId: string, v: HHVacancy) {
  return {
    job_id: jobId,
    vacancy_id: v.vacancy_id,
    name: v.name,
    url: v.url,
    salary_from: v.salary_from ?? null,
    salary_to: v.salary_to ?? null,
    salary_currency: v.salary_currency ?? null,
    company_name: v.company_name,
    company_url: v.company_url ?? null,
    company_site_url: v.company_site_url ?? null,
    company_description: v.company_description ?? null,
    area: v.area,
    industries: v.industries ?? [],
    published_at: v.published_at ?? null,
  };
}

async function upsertInBatches(supabase: ReturnType<typeof createAuthedSupabaseClient>, rows: Array<Record<string, unknown>>) {
  const batchSize = 250;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await supabase
      .from('hh_vacancies')
      .upsert(batch, { onConflict: 'job_id,vacancy_id' });
    if (error) throw error;
  }
}

export async function POST(req: NextRequest) {
  const auth = await getSupabase(req);
  if ('error' in auth) return auth.error;

  const { supabase, user } = auth;
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const route = req.nextUrl.pathname;
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const logMeta = { userId: user.id, requestId, route, ip };

  let body: { job_id?: string };
  try {
    body = (await req.json()) as { job_id?: string };
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const jobId = body.job_id;
  if (!jobId) return jsonError('Missing required field: job_id', 400);

  const startedAt = Date.now();

  const { data: job, error: jobError } = await supabase
    .from('parser_jobs')
    .select('*')
    .eq('id', jobId)
    .eq('user_id', user.id)
    .single();

  if (jobError || !job) return jsonError('Job not found', 404);
  if (job.parser_type !== PARSER_TYPE) return jsonError('Unsupported parser_type', 400);

  const config = job.config as HHSearchConfig;
  await logAudit('parser.hh.execute.start', 'HH parser execution started', { jobId, config }, logMeta);

  const { error: startError } = await supabase
    .from('parser_jobs')
    .update({ status: 'running', started_at: new Date().toISOString(), error_message: null })
    .eq('id', jobId);
  if (startError) return jsonError(startError.message, 500);

  try {
    const { found, vacancies } = await fetchVacancies(config, { jobId, logMeta });
    await logInfo('parser.hh.fetch.completed', 'HH vacancies fetched', { jobId, found, fetched: vacancies.length }, logMeta);
    const uniq = new Map<string, HHVacancy>();
    for (const v of vacancies) uniq.set(v.vacancy_id, v);
    const uniqueVacancies = Array.from(uniq.values());
    await logInfo('parser.hh.dedupe.completed', 'HH vacancies deduplicated', { jobId, parsed: uniqueVacancies.length }, logMeta);

    const rows = uniqueVacancies.map((v) => toDbRow(jobId, v));
    await logInfo('parser.hh.upsert.start', 'HH vacancies upsert started', { jobId, rows: rows.length }, logMeta);
    await upsertInBatches(supabase, rows);
    await logInfo('parser.hh.upsert.completed', 'HH vacancies upsert completed', { jobId }, logMeta);

    const { error: doneError } = await supabase
      .from('parser_jobs')
      .update({
        status: 'completed',
        total_found: found,
        total_parsed: uniqueVacancies.length,
        completed_at: new Date().toISOString(),
        error_message: null,
      })
      .eq('id', jobId);
    if (doneError) return jsonError(doneError.message, 500);

    await logAudit(
      'parser.hh.execute.completed',
      'HH parser execution completed',
      {
        jobId,
        found,
        parsed: uniqueVacancies.length,
        elapsed_ms: Date.now() - startedAt,
      },
      logMeta,
    );
    return NextResponse.json({ status: 'completed', found, parsed: uniqueVacancies.length });
  } catch (err: unknown) {
    let message = err instanceof Error ? err.message : (typeof err === 'string' ? err : 'Unknown error');
    let extra: Record<string, unknown> | undefined;
    let jobMessage = message;

    if (err instanceof HHApiError) {
      message = err.message;
      jobMessage = err.captchaUrl ? 'HH API требует капчу' : message;
      extra = {
        ...(err.captchaUrl ? { captcha_url: err.captchaUrl } : {}),
        ...(err.requestId ? { request_id: err.requestId } : {}),
      };
    }

    await supabase
      .from('parser_jobs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_message: jobMessage,
      })
      .eq('id', jobId);

    await logError(
      'parser.hh.execute.failed',
      err,
      {
        jobId,
        elapsed_ms: Date.now() - startedAt,
        message,
        ...(extra ?? {}),
      },
      logMeta,
    );
    return jsonError(message, 500, extra);
  }
}


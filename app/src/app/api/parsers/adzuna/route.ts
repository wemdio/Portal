import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { logAudit, logError } from '@/lib/loggerServer';
import { ADZUNA_COUNTRY_CODES } from '@/lib/parsers/adzunaConfig';
import type { AdzunaSearchConfig } from '@/types';

export const dynamic = 'force-dynamic';

const PARSER_TYPE = 'adzuna_companies' as const;
const MAX_PAGES = 20;
const VALID_COUNTRIES = new Set<string>(ADZUNA_COUNTRY_CODES);

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
      await logError('parser.adzuna.auth.failed', error ?? 'User not found', { hasUser: Boolean(data?.user) }, logMeta);
      return { error: jsonError('Unauthorized', 401, { request_id: requestId }) };
    }
    return { supabase, user: data.user };
  } catch (err) {
    await logError('parser.adzuna.auth.exception', err, undefined, logMeta);
    return { error: jsonError('Unauthorized', 401, { request_id: requestId }) };
  }
}

export async function GET(req: NextRequest) {
  const auth = await getSupabase(req);
  if ('error' in auth) return auth.error;

  const { supabase, user } = auth;
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const logMeta = { userId: user.id, requestId, route: req.nextUrl.pathname };

  const { data, error } = await supabase
    .from('parser_jobs')
    .select('*')
    .eq('parser_type', PARSER_TYPE)
    .order('created_at', { ascending: false })
    .limit(25);

  if (error) {
    await logError('parser.adzuna.jobs.list.failed', error, { parserType: PARSER_TYPE }, logMeta);
    return jsonError(error.message, 500, { request_id: requestId });
  }
  return NextResponse.json({ jobs: data ?? [] });
}

function sanitizeConfig(raw: Partial<AdzunaSearchConfig>): AdzunaSearchConfig {
  const text = String(raw.text ?? '').trim().slice(0, 300);

  const countries = Array.isArray(raw.countries)
    ? Array.from(new Set(raw.countries.map((c) => String(c).toLowerCase()).filter((c) => VALID_COUNTRIES.has(c))))
    : [];

  const daysNum = Number(raw.posted_within_days);
  const posted_within_days = Number.isFinite(daysNum) ? Math.max(0, Math.min(3650, Math.trunc(daysNum))) : 0;

  const pagesNum = Number(raw.pages);
  const pages = Number.isFinite(pagesNum) ? Math.max(1, Math.min(MAX_PAGES, Math.trunc(pagesNum))) : 3;

  return {
    text: text || 'marketing manager',
    countries: countries.length ? countries : ['us'],
    posted_within_days,
    pages,
    enrich: raw.enrich !== false,
  };
}

export async function POST(req: NextRequest) {
  const auth = await getSupabase(req);
  if ('error' in auth) return auth.error;

  const { supabase, user } = auth;
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const logMeta = { userId: user.id, requestId, route: req.nextUrl.pathname };

  let raw: Partial<AdzunaSearchConfig>;
  try {
    raw = (await req.json()) as Partial<AdzunaSearchConfig>;
  } catch {
    return jsonError('Invalid JSON body', 400, { request_id: requestId });
  }
  if (!raw || typeof raw !== 'object') {
    return jsonError('Invalid config payload', 400, { request_id: requestId });
  }

  const config = sanitizeConfig(raw);

  const { data, error } = await supabase
    .from('parser_jobs')
    .insert({
      user_id: user.id,
      parser_type: PARSER_TYPE,
      status: 'pending',
      progress_stage: 'pending',
      progress_percent: 0,
      config,
      total_found: null,
      total_parsed: null,
      started_at: null,
      completed_at: null,
      error_message: null,
    })
    .select('*')
    .single();

  if (error) {
    await logError('parser.adzuna.job.create.failed', error, { parserType: PARSER_TYPE }, logMeta);
    return jsonError(error.message, 500, { request_id: requestId });
  }

  await logAudit('parser.adzuna.job.created', 'Adzuna parser job created', { jobId: data?.id, config }, logMeta);
  return NextResponse.json({ job: data });
}

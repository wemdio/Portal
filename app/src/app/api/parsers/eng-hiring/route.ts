import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { logAudit, logError } from '@/lib/loggerServer';
import { ATS_COUNTRY_CODES } from '@/lib/parsers/atsFilters';
import { DEFAULT_ENG_HIRING_SOURCES, ENG_HIRING_SOURCES, type EngHiringSearchConfig, type EngHiringSource } from '@/lib/parsers/engHiring';

export const dynamic = 'force-dynamic';

const PARSER_TYPE = 'eng_hiring' as const;
const MAX_COMPANIES_LIMIT = 5000;
const MAX_RESULTS = 20000;
const VALID_COUNTRIES = new Set<string>(ATS_COUNTRY_CODES);

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
      await logError('parser.eng_hiring.auth.failed', error ?? 'User not found', { hasUser: Boolean(data?.user) }, logMeta);
      return { error: jsonError('Unauthorized', 401, { request_id: requestId }) };
    }
    return { supabase, user: data.user };
  } catch (err) {
    await logError('parser.eng_hiring.auth.exception', err, undefined, logMeta);
    return { error: jsonError('Unauthorized', 401, { request_id: requestId }) };
  }
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function sanitizeConfig(raw: Partial<EngHiringSearchConfig>): EngHiringSearchConfig {
  const sources = Array.isArray(raw.sources)
    ? raw.sources
        .map((s) => String(s).toLowerCase())
        .filter((s): s is EngHiringSource => ENG_HIRING_SOURCES.includes(s as EngHiringSource))
    : [];

  const countries = Array.isArray(raw.countries)
    ? Array.from(new Set(raw.countries.map((c) => String(c).toLowerCase()).filter((c) => VALID_COUNTRIES.has(c))))
    : [];

  const text = String(raw.text ?? '').trim().slice(0, 200);
  const companiesLimit = clampNumber(raw.companies_limit, 1000, 0, MAX_COMPANIES_LIMIT);
  const maxResults = clampNumber(raw.max_results, 5000, 1, MAX_RESULTS);
  const postedWithinDays = clampNumber(raw.posted_within_days, 30, 0, 3650);
  const cacheMaxAgeHours = clampNumber(raw.cache_max_age_hours, 12, 1, 24 * 14);

  return {
    text: text || 'english hiring',
    sources: sources.length ? Array.from(new Set(sources)) : [...DEFAULT_ENG_HIRING_SOURCES],
    countries: countries.length ? countries : undefined,
    posted_within_days: postedWithinDays,
    companies_limit: companiesLimit,
    max_results: maxResults,
    cache_max_age_hours: cacheMaxAgeHours,
    refresh_cache: raw.refresh_cache !== false,
    enrich: raw.enrich !== false,
    dedupe_companies: raw.dedupe_companies !== false,
    include_unknown_dates: raw.include_unknown_dates === true,
  };
}

export async function GET(req: NextRequest) {
  const auth = await getSupabase(req);
  if ('error' in auth) return auth.error;

  const { supabase, user } = auth;
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const route = req.nextUrl.pathname;
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const logMeta = { userId: user.id, requestId, route, ip };

  const { data, error } = await supabase
    .from('parser_jobs')
    .select('*')
    .eq('parser_type', PARSER_TYPE)
    .order('created_at', { ascending: false })
    .limit(25);

  if (error) {
    await logError('parser.eng_hiring.jobs.list.failed', error, { parserType: PARSER_TYPE }, logMeta);
    return jsonError(error.message, 500, { request_id: requestId });
  }
  return NextResponse.json({ jobs: data ?? [] });
}

export async function POST(req: NextRequest) {
  const auth = await getSupabase(req);
  if ('error' in auth) return auth.error;

  const { supabase, user } = auth;
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const route = req.nextUrl.pathname;
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const logMeta = { userId: user.id, requestId, route, ip };

  let raw: Partial<EngHiringSearchConfig>;
  try {
    raw = (await req.json()) as Partial<EngHiringSearchConfig>;
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
    await logError('parser.eng_hiring.job.create.failed', error, { parserType: PARSER_TYPE }, logMeta);
    return jsonError(error.message, 500, { request_id: requestId });
  }

  await logAudit('parser.eng_hiring.job.created', 'ENG hiring parser job created', { jobId: data?.id, config }, logMeta);
  return NextResponse.json({ job: data });
}

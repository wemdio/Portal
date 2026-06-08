import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { logAudit, logError } from '@/lib/loggerServer';
import { ATS_COUNTRY_CODES } from '@/lib/parsers/atsFilters';
import type { AtsSearchConfig, AtsType } from '@/types';

export const dynamic = 'force-dynamic';

const PARSER_TYPE = 'ats_companies' as const;
const SUPPORTED_ATS: AtsType[] = ['greenhouse', 'lever', 'ashby'];
const MAX_COMPANIES_LIMIT = 2000;
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
      await logError('parser.ats.auth.failed', error ?? 'User not found', { hasUser: Boolean(data?.user) }, logMeta);
      return { error: jsonError('Unauthorized', 401, { request_id: requestId }) };
    }
    return { supabase, user: data.user };
  } catch (err) {
    await logError('parser.ats.auth.exception', err, undefined, logMeta);
    return { error: jsonError('Unauthorized', 401, { request_id: requestId }) };
  }
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
    await logError('parser.ats.jobs.list.failed', error, { parserType: PARSER_TYPE }, logMeta);
    return jsonError(error.message, 500, { request_id: requestId });
  }
  return NextResponse.json({ jobs: data ?? [] });
}

function sanitizeConfig(raw: Partial<AtsSearchConfig>): AtsSearchConfig {
  const ats = Array.isArray(raw.ats)
    ? raw.ats.map((a) => String(a).toLowerCase()).filter((a): a is AtsType => (SUPPORTED_ATS as string[]).includes(a))
    : [];
  const finalAts = ats.length ? Array.from(new Set(ats)) : [...SUPPORTED_ATS];

  const countries = Array.isArray(raw.countries)
    ? Array.from(new Set(raw.countries.map((c) => String(c).toLowerCase()).filter((c) => VALID_COUNTRIES.has(c))))
    : [];

  const daysNum = Number(raw.posted_within_days);
  const posted_within_days = Number.isFinite(daysNum) ? Math.max(0, Math.min(3650, Math.trunc(daysNum))) : 0;

  const limitNum = Number(raw.companies_limit);
  const companies_limit = Number.isFinite(limitNum) ? Math.max(0, Math.min(MAX_COMPANIES_LIMIT, Math.trunc(limitNum))) : 200;

  const text = String(raw.text ?? '').trim().slice(0, 200);

  return {
    text: text || 'ATS companies',
    ats: finalAts,
    countries: countries.length ? countries : undefined,
    posted_within_days,
    companies_limit,
    enrich: raw.enrich !== false,
  };
}

export async function POST(req: NextRequest) {
  const auth = await getSupabase(req);
  if ('error' in auth) return auth.error;

  const { supabase, user } = auth;
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const route = req.nextUrl.pathname;
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const logMeta = { userId: user.id, requestId, route, ip };

  let raw: Partial<AtsSearchConfig>;
  try {
    raw = (await req.json()) as Partial<AtsSearchConfig>;
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
    await logError('parser.ats.job.create.failed', error, { parserType: PARSER_TYPE }, logMeta);
    return jsonError(error.message, 500, { request_id: requestId });
  }

  await logAudit('parser.ats.job.created', 'ATS parser job created', { jobId: data?.id, config }, logMeta);
  return NextResponse.json({ job: data });
}

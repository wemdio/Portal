import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import type { HHSearchConfig } from '@/lib/parsers/hhParser';
import { logAudit, logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

const PARSER_TYPE = 'hh_vacancies' as const;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

async function getSupabase(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { error: jsonError('Unauthorized', 401) };

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: jsonError('Unauthorized', 401) };

  return { supabase, user };
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
    await logError('parser.hh.jobs.list.failed', error, { parserType: PARSER_TYPE }, logMeta);
    return jsonError(error.message, 500);
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

  let config: HHSearchConfig;
  try {
    config = (await req.json()) as HHSearchConfig;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  if (!config || typeof config !== 'object') {
    return jsonError('Invalid config payload', 400);
  }

  const { data, error } = await supabase
    .from('parser_jobs')
    .insert({
      user_id: user.id,
      parser_type: PARSER_TYPE,
      status: 'pending',
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
    await logError('parser.hh.job.create.failed', error, { parserType: PARSER_TYPE }, logMeta);
    return jsonError(error.message, 500);
  }

  await logAudit(
    'parser.hh.job.created',
    'HH parser job created',
    { jobId: data?.id, parserType: PARSER_TYPE, config },
    logMeta,
  );
  return NextResponse.json({ job: data });
}


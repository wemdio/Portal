import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import type { HHSearchConfig } from '@/lib/parsers/hhParser';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getClientTariffUsage, isClientToolAccessAllowed, isAwaitingFirstPayment, TOOL_ACCESS_DENIED_MESSAGE, AWAITING_PAYMENT_MESSAGE } from '@/lib/tariffs';
import { blockDemo } from '@/lib/auth/blockDemo';

export const dynamic = 'force-dynamic';

const PARSER_TYPE = 'hh_vacancies' as const;

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
    return jsonError(error.message, 500, { request_id: requestId });
  }
  return NextResponse.json({ jobs: data ?? [] });
}

export async function POST(req: NextRequest) {
  const auth = await getSupabase(req);
  if ('error' in auth) return auth.error;

  const { supabase, user } = auth;
  const demo = await blockDemo(supabase, user.id);
  if (demo) return demo;
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const route = req.nextUrl.pathname;
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const logMeta = { userId: user.id, requestId, route, ip };

  let config: HHSearchConfig;
  try {
    config = (await req.json()) as HHSearchConfig;
  } catch {
    return jsonError('Invalid JSON body', 400, { request_id: requestId });
  }

  if (!config || typeof config !== 'object') {
    return jsonError('Invalid config payload', 400, { request_id: requestId });
  }

  let tariffUsage: Awaited<ReturnType<typeof getClientTariffUsage>> | null = null;
  if (supabaseAdmin) {
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (profile?.role === 'client') {
      tariffUsage = await getClientTariffUsage(user.id);
      // Парсер — подготовительный инструмент: доступен и в фазе прогрева (setup),
      // блокируем только неоплаченных. Запуск кампаний режется отдельно (runLaunch).
      if (!isClientToolAccessAllowed(tariffUsage.status)) {
        return jsonError(
          TOOL_ACCESS_DENIED_MESSAGE,
          403,
          { request_id: requestId, tariff_usage: tariffUsage },
        );
      }
      // Оформил подписку, но ещё не оплатил (payment_locked && paid_at пусто) —
      // доступа нет до оплаты (или ручного «Снять блокировку» админом).
      if (isAwaitingFirstPayment(tariffUsage)) {
        return jsonError(
          AWAITING_PAYMENT_MESSAGE,
          403,
          { request_id: requestId, tariff_usage: tariffUsage },
        );
      }
      if (tariffUsage.usage.max_rows.remaining <= 0) {
        return jsonError(
          'Лимит запросов по тарифу исчерпан.',
          429,
          { request_id: requestId, tariff_usage: tariffUsage },
        );
      }
    }
  }

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
    await logError('parser.hh.job.create.failed', error, { parserType: PARSER_TYPE }, logMeta);
    return jsonError(error.message, 500, { request_id: requestId });
  }

  await logAudit(
    'parser.hh.job.created',
    'HH parser job created',
    { jobId: data?.id, parserType: PARSER_TYPE, searchText: config.text, config },
    logMeta,
  );
  return NextResponse.json({ job: data, tariff_usage: tariffUsage });
}


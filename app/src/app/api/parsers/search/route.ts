
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getClientTariffUsage, isClientToolAccessAllowed, TOOL_ACCESS_DENIED_MESSAGE } from '@/lib/tariffs';

export const dynamic = 'force-dynamic';

type SearchJobPayload = {
  brief?: unknown;
  user_query?: unknown;
  queries?: unknown;
  queries_text?: unknown;
  search_depth?: unknown;
};

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const { data: jobs, error } = await supabase
    .from('search_parser_jobs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    return jsonError(error.message, 500);
  }

  return NextResponse.json({ jobs });
}

export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  // Demo accounts are strictly read-only — block real (paid) search jobs. Read via
  // the user's own client (RLS self-read) so it does NOT depend on supabaseAdmin
  // being configured (otherwise a misconfig would fail OPEN for demo).
  const { data: selfProfile } = await supabase
    .from('profiles')
    .select('is_demo')
    .eq('id', user.id)
    .single();
  if (selfProfile?.is_demo === true) {
    return jsonError('Демо-режим: запуск поиска недоступен.', 403);
  }

  try {
    const payload = (await req.json()) as SearchJobPayload;
    const brief = typeof payload?.brief === 'string' ? payload.brief.trim() : '';
    const user_query = typeof payload?.user_query === 'string' ? payload.user_query.trim() : brief;

    let queries: string[] =
      Array.isArray(payload?.queries) ? payload.queries.filter((q: unknown) => typeof q === 'string' && String(q).trim()) : [];

    const queriesText = typeof payload?.queries_text === 'string' ? payload.queries_text.trim() : '';
    if (queriesText) {
      queries = queriesText
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    }

    const hasQueries = queries.length > 0;

    if (!hasQueries && !brief) {
      return jsonError('Missing brief or queries', 400);
    }

    const rawDepth = Number(payload?.search_depth);
    const search_depth = Number.isFinite(rawDepth) ? Math.max(1, Math.min(30, Math.round(rawDepth))) : 5;

    const config = {
      ...(brief ? { brief } : {}),
      ...(hasQueries ? { queries } : {}),
      ...(user_query ? { user_query } : {}),
      search_depth,
    };

    let tariffUsage: Awaited<ReturnType<typeof getClientTariffUsage>> | null = null;
    if (supabaseAdmin) {
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .single();

      if (profile?.role === 'client') {
        tariffUsage = await getClientTariffUsage(user.id);
        if (!isClientToolAccessAllowed(tariffUsage.status)) {
          return jsonError(TOOL_ACCESS_DENIED_MESSAGE, 403);
        }
        if (tariffUsage.usage.max_rows.remaining <= 0) {
          return jsonError('Лимит запросов по тарифу исчерпан.', 429);
        }
      }
    }

    const { data: job, error } = await supabase
      .from('search_parser_jobs')
      .insert({
        user_id: user.id,
        status: 'pending',
        config,
        total_queries: hasQueries ? queries.length : 0,
      })
      .select()
      .single();

    if (error || !job) {
      throw new Error(error?.message || 'Failed to create job');
    }

    return NextResponse.json({ job, tariff_usage: tariffUsage });
  } catch (err) {
    console.error('Create search job error:', err);
    return jsonError('Internal Server Error', 500);
  }
}

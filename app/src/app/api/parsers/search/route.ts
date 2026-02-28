
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

export const dynamic = 'force-dynamic';

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

  try {
    const payload = await req.json();
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

    const config = {
      ...(brief ? { brief } : {}),
      ...(hasQueries ? { queries } : {}),
      ...(user_query ? { user_query } : {}),
    };

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

    return NextResponse.json({ job });
  } catch (err) {
    console.error('Create search job error:', err);
    return jsonError('Internal Server Error', 500);
  }
}

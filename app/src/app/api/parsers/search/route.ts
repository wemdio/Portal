
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
    .order('created_at', { ascending: false });

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
    const { queries } = await req.json();
    if (!queries || !Array.isArray(queries) || queries.length === 0) {
      return jsonError('Missing or empty queries', 400);
    }

    const { data: job, error } = await supabase
      .from('search_parser_jobs')
      .insert({
        user_id: user.id,
        status: 'pending',
        config: { queries },
        total_queries: queries.length,
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

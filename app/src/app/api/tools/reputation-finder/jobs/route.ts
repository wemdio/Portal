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
    .from('reputation_jobs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ jobs: jobs ?? [] });
}

export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const body = await req.json().catch(() => null);
  if (!body) return jsonError('Invalid JSON body', 400);

  const mode = body.mode;
  if (mode !== 'local_reviews' && mode !== 'brand_serp' && mode !== 'auto_search') {
    return jsonError('mode must be "local_reviews", "brand_serp", or "auto_search"', 400);
  }

  const config = body.config ?? {};

  const { data: job, error } = await supabase
    .from('reputation_jobs')
    .insert({
      user_id: user.id,
      status: 'pending',
      mode,
      config,
    })
    .select()
    .single();

  if (error || !job) return jsonError(error?.message ?? 'Failed to create job', 500);
  return NextResponse.json({ job });
}

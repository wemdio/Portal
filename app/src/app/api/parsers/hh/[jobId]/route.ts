import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

export const dynamic = 'force-dynamic';

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

export async function GET(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const auth = await getSupabase(req);
  if ('error' in auth) return auth.error;

  const { supabase } = auth;
  const { jobId } = await ctx.params;

  const { data, error } = await supabase
    .from('parser_jobs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (error) return jsonError(error.message, 404);
  return NextResponse.json({ job: data });
}


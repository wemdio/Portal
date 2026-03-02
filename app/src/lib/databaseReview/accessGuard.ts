import 'server-only';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function requireDatabaseReviewAccess(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { error: jsonError('Unauthorized', 401) };

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: jsonError('Unauthorized', 401) };

  if (!supabaseAdmin) return { error: jsonError('Server misconfigured', 500) };

  const { data: row } = await supabaseAdmin
    .from('user_tool_visibility')
    .select('enabled')
    .eq('user_id', user.id)
    .eq('tool_id', 'database-review')
    .maybeSingle();

  const hasAccess = row?.enabled === true;
  if (!hasAccess) return { error: jsonError('Forbidden: database-review access required', 403) };

  return { user, supabaseAdmin };
}

export async function requireAuth(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { error: jsonError('Unauthorized', 401) };

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: jsonError('Unauthorized', 401) };

  if (!supabaseAdmin) return { error: jsonError('Server misconfigured', 500) };

  return { user, supabaseAdmin };
}

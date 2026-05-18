import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isTechnician } from '@/lib/roles';
import type { UserRole } from '@/types';

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
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!isTechnician((profile?.role ?? null) as UserRole | null)) {
    return jsonError('Forbidden', 403);
  }

  const search = new URL(req.url).searchParams.get('q') ?? '';

  let query = supabaseAdmin
    .from('profiles')
    .select('id, full_name, email')
    .eq('role', 'client')
    .order('full_name', { ascending: true })
    .limit(30);

  if (search.trim()) {
    query = query.or(`full_name.ilike.%${search}%,email.ilike.%${search}%`);
  }

  const { data, error } = await query;
  if (error) return jsonError('Failed to load clients', 500);

  return NextResponse.json({ clients: data ?? [] });
}

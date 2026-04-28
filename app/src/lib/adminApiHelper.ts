import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isAdmin } from '@/lib/roles';
import type { UserRole } from '@/types';

export function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export interface AdminAuthResult {
  user: { id: string };
}

/**
 * Authenticate an admin user. Returns the user or sends an error response.
 * Used by every /api/admin/* route that mutates state.
 */
export async function requireAdminAuth(
  req: NextRequest,
): Promise<{ auth: AdminAuthResult } | { error: NextResponse }> {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { error: jsonError('Unauthorized', 401) };

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: jsonError('Unauthorized', 401) };
  if (!supabaseAdmin) return { error: jsonError('Server misconfigured', 500) };

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!isAdmin((profile?.role ?? null) as UserRole | null)) {
    return { error: jsonError('Forbidden', 403) };
  }

  return { auth: { user: { id: user.id } } };
}

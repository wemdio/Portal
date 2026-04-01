import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import type { ClientAccessRow } from '@/lib/clientAccess';

export function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export interface ClientAuthResult {
  userId: string;
  accessRows: ClientAccessRow[];
}

/**
 * Authenticate a client user and load their Instantly access rows.
 * Returns null + sends error response if auth fails.
 */
export async function requireClientAuth(
  req: NextRequest,
): Promise<{ auth: ClientAuthResult } | { error: NextResponse }> {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { error: jsonError('Unauthorized', 401) };

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: jsonError('Unauthorized', 401) };
  if (!supabaseAdmin) return { error: jsonError('Server misconfigured', 500) };
  if (!supabaseInstantly) return { error: jsonError('Server misconfigured', 500) };

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  const role = profile?.role ?? null;
  if (role !== 'client' && role !== 'admin') {
    return { error: jsonError('Forbidden', 403) };
  }

  const { data: rows } = await supabaseInstantly
    .from('client_instantly_access')
    .select('resource_type, resource_id')
    .eq('client_user_id', user.id);

  return {
    auth: {
      userId: user.id,
      accessRows: (rows ?? []) as ClientAccessRow[],
    },
  };
}

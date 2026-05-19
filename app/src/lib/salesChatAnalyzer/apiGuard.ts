import 'server-only';

import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isTechnician } from '@/lib/roles';
import type { UserRole } from '@/types';

/**
 * Гард доступа к инструменту «Анализатор сейлз-переписок».
 * Инструмент внутренний — доступ только техникам и админам (isTechnician).
 */
export type GuardResult =
  | { ok: true; userId: string; role: UserRole }
  | { ok: false; status: number; error: string };

export async function requireSalesChatAccess(req: NextRequest): Promise<GuardResult> {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { ok: false, status: 401, error: 'Unauthorized' };

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, status: 401, error: 'Unauthorized' };

  if (!supabaseAdmin) return { ok: false, status: 500, error: 'Server misconfigured' };

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  const role = (profile?.role ?? null) as UserRole | null;
  if (!isTechnician(role)) {
    return { ok: false, status: 403, error: 'Доступ только для техников и админов' };
  }
  return { ok: true, userId: user.id, role: role as UserRole };
}

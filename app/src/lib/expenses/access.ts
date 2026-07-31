import 'server-only';

import type { NextRequest } from 'next/server';

import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { UserRole } from '@/types';

/**
 * Гард доступа к расходам.
 *
 * Совпадает с правилом видимости вкладки (`isNavTabVisible` в lib/navigation):
 * админ проходит всегда, остальным нужен выданный тумблер nav-expenses.
 * Скрытый пункт меню защитой не является — данные закрыты здесь.
 */
export const EXPENSES_NAV_TAB_ID = 'nav-expenses';

export type ExpensesGuardResult =
  | { ok: true; userId: string; role: UserRole | null }
  | { ok: false; status: number; error: string };

export async function requireExpensesAccess(req: NextRequest): Promise<ExpensesGuardResult> {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { ok: false, status: 401, error: 'Unauthorized' };

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, status: 401, error: 'Unauthorized' };

  if (!supabaseAdmin) return { ok: false, status: 500, error: 'Server misconfigured' };

  const [{ data: profile }, { data: visibility }] = await Promise.all([
    supabaseAdmin.from('profiles').select('role').eq('id', user.id).single(),
    supabaseAdmin
      .from('user_tool_visibility')
      .select('enabled')
      .eq('user_id', user.id)
      .eq('tool_id', EXPENSES_NAV_TAB_ID)
      .maybeSingle(),
  ]);

  const role = (profile?.role ?? null) as UserRole | null;

  if (role !== 'admin' && visibility?.enabled !== true) {
    return {
      ok: false,
      status: 403,
      error: 'Доступ к расходам не выдан. Попроси админа включить вкладку в твоём профиле.',
    };
  }

  return { ok: true, userId: user.id, role };
}

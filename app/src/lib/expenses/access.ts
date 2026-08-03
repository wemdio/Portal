import 'server-only';

import type { NextRequest } from 'next/server';

import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { UserRole } from '@/types';

/**
 * Гард раздела «Деньги» — и расходов, и доходов.
 *
 * Решает только роль: `admin` проходит, все остальные получают 403. Точечной
 * выдачи больше нет — `user_tool_visibility` здесь не читается вовсе, и строка
 * в этой таблице доступа не даёт. Пункт меню закрыт флагом `adminOnly` в
 * `lib/navigation`, но скрытый пункт защитой не является: сюда можно прийти
 * прямой ссылкой, и данные закрыты именно здесь.
 */

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

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  const role = (profile?.role ?? null) as UserRole | null;

  if (role !== 'admin') {
    return { ok: false, status: 403, error: 'Раздел «Деньги» доступен только админам' };
  }

  return { ok: true, userId: user.id, role };
}

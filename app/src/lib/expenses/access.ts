import 'server-only';

import type { NextRequest } from 'next/server';

import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { UserRole } from '@/types';

/** Тумблер точечной выдачи раздела в админке. Совпадает с `navTabId` пункта меню. */
export const EXPENSES_NAV_TAB_ID = 'nav-expenses';

/**
 * Гард раздела «Деньги» — и расходов, и доходов.
 *
 * Админ проходит всегда, остальным раздел выдаётся поимённо тумблером
 * «Расходы и доходы» в админке — той же схемой, что дашборды первички и
 * продлений (см. `lib/firstSales/access.ts`). Выданный тумблер даёт полный
 * доступ, второго уровня «только смотреть» здесь нет.
 *
 * Скрытый пункт меню защитой не является: сюда можно прийти прямой ссылкой, и
 * данные закрыты именно здесь.
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
    const { data: row } = await supabaseAdmin
      .from('user_tool_visibility')
      .select('enabled')
      .eq('user_id', user.id)
      .eq('tool_id', EXPENSES_NAV_TAB_ID)
      .maybeSingle();

    if (row?.enabled !== true) {
      return { ok: false, status: 403, error: 'Раздел «Деньги» вам не выдан' };
    }
  }

  return { ok: true, userId: user.id, role };
}

import 'server-only';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import type { User } from '@supabase/supabase-js';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isAdmin } from '@/lib/roles';
import type { UserRole } from '@/types';

export const FIRST_SALES_NAV_TAB_ID = 'nav-first-sales';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Результат гарда — размеченное объединение с ЯВНОЙ аннотацией. Без неё tsc
 * инферит слишком широкий тип из 4+ точек `return { error }`: `'error' in res`
 * не сужает `res.error` (TS18048 "possibly undefined") ни в if, ни в тернарнике
 * — воспроизведено отдельным репро на tsc 5.9.3. Явная аннотация — единственный
 * надёжный способ получить чистое объединение у консьюмеров через
 * `Awaited<ReturnType<typeof requireFirstSalesAccess>>`.
 */
type FirstSalesAccessResult =
  | { error: ReturnType<typeof jsonError> }
  | { user: User; supabaseAdmin: NonNullable<typeof supabaseAdmin> };

/**
 * Доступ к дашборду первички. Схема та же, что у дашборда расходов:
 * скрытый пункт меню — не защита, поэтому каждый роут проверяется на сервере.
 * Админ проходит всегда; остальным вкладка выдаётся точечно в админке.
 */
export async function requireFirstSalesAccess(req: NextRequest): Promise<FirstSalesAccessResult> {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { error: jsonError('Unauthorized', 401) };

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: jsonError('Unauthorized', 401) };

  if (!supabaseAdmin) return { error: jsonError('Server misconfigured', 500) };

  const { data: profile, error } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  // PGRST116 = «строки нет»; это отсутствие профиля, а не сбой БД. Любую другую
  // ошибку отдаём как 503: иначе блип базы читается как «доступ запрещён».
  if (error && error.code !== 'PGRST116') {
    return { error: jsonError('role_check_failed', 503) };
  }
  if (isAdmin((profile?.role ?? null) as UserRole | null)) {
    return { user, supabaseAdmin };
  }

  const { data: row } = await supabaseAdmin
    .from('user_tool_visibility')
    .select('enabled')
    .eq('user_id', user.id)
    .eq('tool_id', FIRST_SALES_NAV_TAB_ID)
    .maybeSingle();

  if (row?.enabled !== true) {
    return { error: jsonError('Forbidden: first-sales access required', 403) };
  }
  return { user, supabaseAdmin };
}

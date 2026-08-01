import 'server-only';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import type { User } from '@supabase/supabase-js';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isAdmin } from '@/lib/roles';
import type { UserRole } from '@/types';

export const RENEWALS_NAV_TAB_ID = 'nav-renewals';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Размеченное объединение с ЯВНОЙ аннотацией возвращаемого типа — тот же
 * приём, что в firstSales/access.ts. Без неё tsc инферит слишком широкий тип
 * из 4+ точек `return { error }`: `'error' in res` не сужает `res.error`
 * (TS18048) ни в if, ни в тернарнике. Явная аннотация — единственный надёжный
 * способ получить чистое объединение у консьюмеров через
 * `Awaited<ReturnType<typeof requireRenewalsAccess>>`.
 */
type RenewalsAccessResult =
  | { error: ReturnType<typeof jsonError> }
  | { user: User; supabaseAdmin: NonNullable<typeof supabaseAdmin> };

/**
 * Доступ к дашборду продлений.
 *
 * Отдельный гард, а не переиспользование `requireFirstSalesAccess` —
 * осознанный выбор, не копипаста по инерции. Общий гард связал бы права
 * доступа двух самостоятельных дашбордов: выдав пользователю «Первичку», он
 * автоматически получил бы и «Продления», хотя это разные вопросы (воронка
 * первичных продаж / уже проданные продления) и разной аудитории может быть
 * нужен только один из них — например, менеджеру по продлениям видеть
 * первичку незачем. Дублирование полусотни строк дешевле, чем неявная связка
 * прав двух независимых экранов, которую потом придётся распутывать.
 *
 * Схема — та же, что у «Первички»: скрытый пункт меню не защита сам по себе,
 * поэтому каждый роут проверяется на сервере. Админ проходит всегда;
 * остальным вкладка выдаётся точечно в админке через `user_tool_visibility`.
 */
export async function requireRenewalsAccess(req: NextRequest): Promise<RenewalsAccessResult> {
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
    .eq('tool_id', RENEWALS_NAV_TAB_ID)
    .maybeSingle();

  if (row?.enabled !== true) {
    return { error: jsonError('Forbidden: renewals access required', 403) };
  }
  return { user, supabaseAdmin };
}

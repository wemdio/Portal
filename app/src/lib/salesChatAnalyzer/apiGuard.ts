import 'server-only';

import type { NextRequest } from 'next/server';

import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { DEFAULT_ON_TOOL_IDS_BY_ROLE } from '@/lib/toolsRegistry';
import type { UserRole } from '@/types';

/**
 * Гард доступа к инструменту «Анализатор сейлз-переписок».
 *
 * Раньше резалось по роли (только technician/admin). Теперь — как у других
 * tool-toggle инструментов: смотрим в `user_tool_visibility` для текущего
 * юзера и tool_id='sales-chat-analyzer'.
 *
 * Логика разрешения должна совпадать с `/api/user/tools` (источник правды
 * для UI-видимости), чтобы юзер не видел инструмент в списке но при этом
 * получал 403 при попытке открыть страницу (или наоборот):
 *   1. Если в `user_tool_visibility` есть строка — её `enabled` имеет приоритет.
 *   2. Если строки нет — дефолт: 'sales-chat-analyzer' включён только для ролей
 *      из `DEFAULT_ON_TOOL_IDS_BY_ROLE` (сейчас — admin/technician).
 *      Остальные могут получить доступ только если админ явно включит им тумблер.
 */
export type GuardResult =
  | { ok: true; userId: string; role: UserRole | null }
  | { ok: false; status: number; error: string };

const TOOL_ID = 'sales-chat-analyzer';

export async function requireSalesChatAccess(req: NextRequest): Promise<GuardResult> {
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
      .eq('tool_id', TOOL_ID)
      .maybeSingle(),
  ]);

  const role = (profile?.role ?? null) as UserRole | null;

  let enabled: boolean;
  if (visibility) {
    // Явная per-user настройка из админки — приоритетна над дефолтом по роли.
    enabled = visibility.enabled === true;
  } else {
    // Нет per-user строки → дефолт. Инструмент в DEFAULT_OFF_TOOL_IDS, но для
    // ролей из DEFAULT_ON_TOOL_IDS_BY_ROLE он включён.
    const roleDefaults = role ? DEFAULT_ON_TOOL_IDS_BY_ROLE[role] ?? [] : [];
    enabled = roleDefaults.includes(TOOL_ID);
  }

  if (!enabled) {
    return {
      ok: false,
      status: 403,
      error: 'Доступ к Анализатору сейлз-переписок выключен. Попроси админа включить тумблер.',
    };
  }

  return { ok: true, userId: user.id, role };
}

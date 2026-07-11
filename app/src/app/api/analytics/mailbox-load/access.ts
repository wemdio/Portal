import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { requireAuth } from '@/lib/instantly/apiRouteHelper';
import { isLead } from '@/lib/roles';
import type { UserRole } from '@/types';

/**
 * Доступ к mailbox-load API = руководство (lead/director/admin), как у страницы
 * /analytics/mailbox-load (middleware ~410). Middleware-гейт /api/* отсекает
 * только клиентов/демо/анонимов, но пускает ВЕСЬ internal-staff — без этой
 * проверки технарь/сейлз мог бы дёргать API напрямую, минуя закрытую страницу.
 * Возвращает NextResponse с ошибкой или null (доступ разрешён).
 */
export async function requireMailboxLoadAccess(req: NextRequest): Promise<NextResponse | null> {
  const user = await requireAuth(req);
  if (!user) return NextResponse.json({ error: 'Необходима авторизация' }, { status: 401 });

  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Необходима авторизация' }, { status: 401 });

  // Роль читаем сами (не через fetchUserRole): тот схлопывает сбой PostgREST в
  // null → директор при блипе БД видел бы 403 «только для руководства» вместо
  // ретраебельной 503. Различаем «профиля нет» (403) и «не смогли проверить» (503).
  const supabase = createAuthedSupabaseClient(token);
  const { data, error } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  if (error && error.code !== 'PGRST116') {
    return NextResponse.json({ error: 'role_check_failed' }, { status: 503 });
  }
  if (!isLead((data?.role ?? null) as UserRole | null)) {
    return NextResponse.json({ error: 'Только для руководства' }, { status: 403 });
  }
  return null;
}

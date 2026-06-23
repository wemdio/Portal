import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isInternalRole } from '@/lib/roles';
import type { UserRole } from '@/types';

export function toolsJsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export interface InternalToolAuth {
  /** Supabase-клиент, авторизованный токеном вызывающего (RLS как у юзера). */
  supabase: ReturnType<typeof createAuthedSupabaseClient>;
  userId: string;
  role: UserRole | null;
}

/**
 * Auth для внутренних /api/tools/* роутов.
 *
 * Проверяет не только аутентификацию, но и что роль НЕ клиентская: middleware
 * редиректит client → /client только на уровне СТРАНИЦ, а `/api/*` он пропускает
 * без проверок (см. middleware.ts), поэтому client-аккаунт мог бы дёрнуть
 * внутренний инструмент напрямую. Для инструментов вроде «Гипотезы по сайту»,
 * которые отдают полный внутренний каталог источников (audience:'internal',
 * включая скрытые от клиентов crypto/signals), роль-гейт обязателен.
 *
 * Роль читаем через supabaseAdmin (как requireClientAuth) — это даёт честную
 * проверку независимо от RLS на profiles.
 */
export async function requireInternalToolAuth(
  req: NextRequest,
): Promise<{ auth: InternalToolAuth } | { error: NextResponse }> {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { error: toolsJsonError('Unauthorized', 401) };

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: toolsJsonError('Unauthorized', 401) };
  if (!supabaseAdmin) return { error: toolsJsonError('Server misconfigured', 500) };

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  const role = (profile?.role ?? null) as UserRole | null;
  if (!isInternalRole(role)) {
    return { error: toolsJsonError('Forbidden', 403) };
  }

  return { auth: { supabase, userId: user.id, role } };
}

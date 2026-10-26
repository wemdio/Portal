import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

import { isInternalUser } from '@/lib/auth/internalGuard';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

/**
 * Сотрудник ли вызвал серверное действие (`'use server'`).
 *
 * Действие — это POST на адрес страницы, и до 26.10.2026 платные запуски
 * сбора (bugor/nash outreach) держались только на middleware страниц. Проверка
 * внутри самого действия не зависит от того, как настроен matcher и какие
 * страницы он пропускает. Сессию берём из cookie, как middleware; fails closed —
 * нет сессии или профиля → false.
 */
export async function isStaffServerAction(): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey || !supabaseAdmin) return false;

  const store = await cookies();
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      get: (name: string) => store.get(name)?.value,
      set() {},
      remove() {},
    },
  });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  return isInternalUser(supabaseAdmin, user.id);
}

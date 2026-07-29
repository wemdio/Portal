import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { TAB_DEMO_HEADER } from '@/lib/clientDemo/demoHeader';

/**
 * Read-only guard for client-facing TOOL routes that are reachable by the public
 * demo account (role=client, is_demo=true) but do NOT go through requireClientAuth
 * (so the centralized demo-mutation block in clientApiHelper doesn't apply).
 *
 * Режет два вида демо:
 *   1. демо-аккаунт (profiles.is_demo) — через authed клиент вызвавшего;
 *   2. демо-вкладку (заголовок TAB_DEMO_HEADER, см. clientDemo/tabDemoMode) —
 *      по заголовку запроса через next/headers; вне request-scope (тесты,
 *      воркеры) headers() кидает — тогда просто пропускаем эту проверку.
 *
 * Reads `is_demo` via the caller's OWN authed Supabase client (RLS self-read), so
 * it does NOT depend on supabaseAdmin being configured. Fails CLOSED: if the read
 * errors (we cannot confirm the caller is NOT a demo account), deny with 503 —
 * never let a read failure open the gate. Returns a 403 for demo accounts, a 503
 * if the check itself failed, else null.
 *
 * Gate every MUTATING / SPEND (non-GET) handler of these tool routes with this:
 *   const demo = await blockDemo(supabase, user.id);
 *   if (demo) return demo;
 * Leave read-only GET handlers (lists, results, exports, downloads) ungated.
 */
export async function blockDemo(
  supabase: SupabaseClient,
  userId: string,
): Promise<NextResponse | null> {
  // Демо-вкладка: заголовок достаточен, в БД не ходим.
  try {
    const { headers } = await import('next/headers');
    const h = await headers();
    if (h.get(TAB_DEMO_HEADER) === '1') {
      return NextResponse.json(
        { error: 'Демо-режим: это витрина портала — запуск инструментов недоступен.', code: 'DEMO_READONLY' },
        { status: 403 },
      );
    }
  } catch {
    // Вне request-scope (тесты, воркеры) — проверка по профилю ниже.
  }

  const { data, error } = await supabase
    .from('profiles')
    .select('is_demo')
    .eq('id', userId)
    .single();
  if (error) {
    // Fail CLOSED — a profile-read failure must NOT open the demo gate.
    return NextResponse.json(
      { error: 'Не удалось проверить доступ, попробуйте ещё раз.', code: 'DEMO_CHECK_FAILED' },
      { status: 503 },
    );
  }
  if (data?.is_demo === true) {
    return NextResponse.json(
      { error: 'Демо-режим: это витрина портала — запуск инструментов недоступен.', code: 'DEMO_READONLY' },
      { status: 403 },
    );
  }
  return null;
}

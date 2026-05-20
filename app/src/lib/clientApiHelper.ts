import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import type { ClientAccessRow } from '@/lib/clientAccess';

export function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export interface ClientAuthResult {
  userId: string;
  accessRows: ClientAccessRow[];
  /** True for the shared demo account (see lib/clientDemo). Strictly read-only. */
  isDemo: boolean;
}

/** HTTP methods that change state — blocked outright for the demo account. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * POST-роуты, которые по сути read-only (формируют отчёт / выполняют поиск,
 * ничего не меняют). Демо-аккаунту они разрешены — роут вернёт фикстуру
 * через serveClientDemo. Всё остальное мутирующее под демо режется.
 */
const DEMO_READONLY_POST_PATHS = new Set([
  '/api/client/reports',
  '/api/client/companies-search',
]);

/**
 * Standardised 403 for any write attempt under the demo account. The client
 * fetcher recognises `code: 'DEMO_READONLY'` and surfaces a friendly toast.
 */
export function demoReadonlyError(): NextResponse {
  return NextResponse.json(
    {
      error: 'Демо-режим: это витрина портала с тестовыми данными, изменять ничего нельзя.',
      code: 'DEMO_READONLY',
    },
    { status: 403 },
  );
}

/**
 * Authenticate a client user and load their Instantly access rows.
 * Returns null + sends error response if auth fails.
 */
export async function requireClientAuth(
  req: NextRequest,
): Promise<{ auth: ClientAuthResult } | { error: NextResponse }> {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { error: jsonError('Unauthorized', 401) };

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: jsonError('Unauthorized', 401) };
  if (!supabaseAdmin) return { error: jsonError('Server misconfigured', 500) };
  if (!supabaseInstantly) return { error: jsonError('Server misconfigured', 500) };

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('role, is_demo')
    .eq('id', user.id)
    .single();

  const role = profile?.role ?? null;
  if (role !== 'client' && role !== 'admin') {
    return { error: jsonError('Forbidden', 403) };
  }

  const isDemo = profile?.is_demo === true;

  // Демо-аккаунт строго read-only. Любой мутирующий запрос режем здесь,
  // централизованно — ни один клиентский роут физически не сможет ничего
  // изменить под демо-юзером (сколько бы человек одновременно ни зашло).
  // Исключение — read-only POST'ы (отчёт, поиск): они отдают фикстуру.
  if (
    isDemo &&
    MUTATING_METHODS.has(req.method) &&
    !DEMO_READONLY_POST_PATHS.has(req.nextUrl.pathname)
  ) {
    return { error: demoReadonlyError() };
  }

  const { data: rows } = await supabaseInstantly
    .from('client_instantly_access')
    .select('resource_type, resource_id, instantly_account_id')
    .eq('client_user_id', user.id);

  return {
    auth: {
      userId: user.id,
      accessRows: (rows ?? []) as ClientAccessRow[],
      isDemo,
    },
  };
}

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import type { ClientAccessRow } from '@/lib/clientAccess';
import { withApiTiming } from '@/lib/apiTiming';
import { scrubBrand } from '@/lib/scrubBrand';

export function jsonError(message: string, status: number) {
  // White-label: never leak the email-engine brand into a client error.
  return NextResponse.json({ error: scrubBrand(message) }, { status });
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
  // Демо-персонализация («вставьте свой сайт»): пишет только в собственную
  // таблицу-кэш demo_personalize_runs, клиентские данные не трогает; свои
  // анти-абуз лимиты внутри роута.
  '/api/client/demo/personalize',
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
  const timingMeta = {
    route: req.nextUrl.pathname,
    method: req.method,
  };

  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { error: jsonError('Unauthorized', 401) };

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await withApiTiming(
    'client.auth.getUser',
    () => supabase.auth.getUser(),
    timingMeta,
  );
  if (!user) return { error: jsonError('Unauthorized', 401) };
  if (!supabaseAdmin) return { error: jsonError('Server misconfigured', 500) };
  if (!supabaseInstantly) return { error: jsonError('Server misconfigured', 500) };
  const admin = supabaseAdmin;
  const instantly = supabaseInstantly;

  // profiles (main-postgres) и client_instantly_access (instantly-postgres)
  // зависят ТОЛЬКО от user.id и независимы друг от друга — тянем их параллельно.
  // Это убирает один последовательный кросс-VPS round-trip (139→144) на КАЖДОМ
  // запросе к /api/client/*: было getUser → profiles → accessRows (3 подряд),
  // стало getUser → (profiles ‖ accessRows) (2). Оба withApiTiming-спана
  // сохранены, поэтому замеры до/после продолжают работать.
  //
  // Поведение идентично прежнему. Единственное отличие: при Forbidden-роли или
  // заблокированной demo-записи мы теперь успеваем прочитать accessRows «вхолостую»
  // (раньше short-circuit'ились до него). Это редкие пути, лишнее чтение дешёвое,
  // а возвращаемый результат тот же.
  const [profileRes, rowsRes] = await Promise.all([
    withApiTiming(
      'client.auth.profile',
      () =>
        admin
          .from('profiles')
          .select('role, is_demo')
          .eq('id', user.id)
          .single(),
      timingMeta,
    ),
    withApiTiming(
      'client.auth.accessRows',
      () =>
        instantly
          .from('client_instantly_access')
          .select('resource_type, resource_id, instantly_account_id')
          .eq('client_user_id', user.id),
      timingMeta,
    ),
  ]);

  // Инфраструктурный сбой чтения профиля (таймаут/блип main-БД) — это НЕ
  // «профиля нет». Без этой проверки profile=null превращал role в null, и
  // клиент получал «Forbidden» из-за секундного блипа БД. PGRST116 («строк
  // нет») — легитимное отсутствие профиля, идёт прежним путём (403 ниже).
  if (profileRes.error && profileRes.error.code !== 'PGRST116') {
    return { error: jsonError('Сервис временно недоступен — обновите страницу', 503) };
  }

  const profile = profileRes.data;

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

  // Инфраструктурный сбой чтения прав доступа (блип instantly-БД, 20с-таймаут
  // PostgREST). Раньше ошибка глоталась → accessRows=[] → роуты честно отвечали
  // «данных нет», и клиент видел «Кампаний пока нет» вместо ошибки с ретраем
  // (инцидент 15.07). Демо не режем: демо-роуты отдают фикстуры, rows не нужны.
  if (!isDemo && rowsRes.error) {
    return { error: jsonError('Сервис временно недоступен — обновите страницу', 503) };
  }

  const rows = rowsRes.data;

  return {
    auth: {
      userId: user.id,
      accessRows: (rows ?? []) as ClientAccessRow[],
      isDemo,
    },
  };
}

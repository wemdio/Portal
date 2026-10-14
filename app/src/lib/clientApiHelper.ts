import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import type { ClientAccessRow } from '@/lib/clientAccess';
import { TAB_DEMO_HEADER } from '@/lib/clientDemo/demoHeader';
import { withApiTiming } from '@/lib/apiTiming';
import { scrubBrand } from '@/lib/scrubBrand';
import { resolveNavMarket, type ClientMarket } from '@/lib/engMarket';

export function jsonError(message: string, status: number) {
  // White-label: never leak the email-engine brand into a client error.
  return NextResponse.json({ error: scrubBrand(message) }, { status });
}

export interface ClientAuthResult {
  userId: string;
  accessRows: ClientAccessRow[];
  /** True for the shared demo account (see lib/clientDemo). Strictly read-only. */
  isDemo: boolean;
  /**
   * Кабинет, который обслуживает ЭТОТ запрос. Роуты под `/api/client/*` общие
   * для двух кабинетов, а язык ответа — нет: RU-экраны печатают `error` как
   * есть, английский клиент не должен увидеть русскую строку ни на экране, ни
   * в теле ответа. Разрешается по запросу (`requestMarket`), а не по колонке
   * профиля, поэтому общий роут больше не зависит от того, вспомнил ли
   * вызывающий экран пометить себя.
   */
  market: ClientMarket;
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

/** Роуты, которые существуют ТОЛЬКО для ENG-кабинета (см. `requestMarket`). */
const ENG_API_PREFIX = '/api/client/eng';

/**
 * Строка профиля глазами гейта. Локальный тип, а не вывод supabase-js: select'а
 * теперь два (с `market` и без — см. 42703 ниже), и их результаты иначе
 * складываются в объединение, из которого не прочитать ни одного поля.
 */
interface ClientProfileRow {
  role?: string | null;
  is_demo?: boolean | null;
  market?: string | null;
}

const PROFILE_COLUMNS = 'role, is_demo, market';
/** Набор до миграции 20260804_0004 (колонки `market` ещё нет) — см. ниже про 42703. */
const PROFILE_COLUMNS_LEGACY = 'role, is_demo';
/** Postgres `undefined_column`; PostgREST отдаёт его кодом ошибки как есть. */
const PG_UNDEFINED_COLUMN = '42703';

/**
 * Кабинет запроса. Три правила, первое сработавшее выигрывает:
 *
 *  1. путь `/api/client/eng/**` — эти роуты обслуживают один кабинет и никогда
 *     не вызываются из RU-контура; правило работает даже когда профиль не
 *     прочитался (блип БД ниже отвечает раньше, чем мы узнаём рынок);
 *  2. Host ENG-кабинета — на нём middleware держит только eng-клиентов
 *     (`middleware.ts`: ru-клиента и стаффа уводит на основной хост);
 *  3. `profiles.market` — eng-клиент на любом другом хосте.
 *
 * Правила 2–3 — это ровно `resolveNavMarket`, которым кабинет уже выбирает
 * навигацию и которым `byoMailbox/accessPolicy` открывает подключение почты:
 * один ответ на вопрос «чей это запрос» во всём контуре, а не третий подряд.
 *
 * Почему не признак от вызывающего (query-параметр, заголовок): его можно
 * забыть, и тогда английский клиент молча получает русский текст — отказ
 * выглядит рабочим, пока кто-нибудь не прочитает payload. Эти три источника
 * забыть нельзя: их проставляет не экран, а сам запрос.
 */
function requestMarket(req: NextRequest, profileMarket?: string | null): ClientMarket {
  const path = req.nextUrl.pathname;
  if (path === ENG_API_PREFIX || path.startsWith(`${ENG_API_PREFIX}/`)) return 'eng';
  return resolveNavMarket(req.headers.get('host'), profileMarket);
}

/**
 * Тексты общего гейта по кабинетам. RU-строки — байт в байт прежние: их
 * печатает RU-кабинет, и ни один из них не переписан.
 */
const DEMO_READONLY_TEXT: Record<ClientMarket, string> = {
  ru: 'Демо-режим: это витрина портала с тестовыми данными, изменять ничего нельзя.',
  eng: 'This is a demo account: the portal is shown with sample data, so nothing here can be changed. Sign in with your own account to make changes.',
};

const UNAVAILABLE_TEXT: Record<ClientMarket, string> = {
  ru: 'Сервис временно недоступен — обновите страницу',
  eng: 'The service is temporarily unavailable — refresh the page.',
};

/**
 * Standardised 403 for any write attempt under the demo account. The client
 * fetcher recognises `code: 'DEMO_READONLY'` and surfaces a friendly toast.
 *
 * Язык — параметром, а не автоопределением внутри: функция чистая, и вызывают
 * её ДВА разных контура. Центральный гейт ниже передаёт разрешённый рынок
 * запроса, то есть весь ENG-контур закрыт одной строкой. Три прямых вызова
 * (`payment`, `auto-pipeline/config`, `manual-scoring/upload`) — RU-роуты,
 * рынка у них нет и дефолт оставляет их ответ прежним до байта. Новому
 * ENG-роуту передать рынок есть откуда: он лежит в `auth.market`.
 */
export function demoReadonlyError(market: ClientMarket = 'ru'): NextResponse {
  return NextResponse.json(
    {
      error: DEMO_READONLY_TEXT[market],
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
  const [profileFirstRes, rowsRes] = await Promise.all([
    withApiTiming(
      'client.auth.profile',
      () =>
        admin
          .from('profiles')
          // `market` — язык ответа общих роутов (см. ClientAuthResult.market).
          // Дочитан к роли одним select'ом: отдельный запрос за рынком стоил бы
          // round-trip на КАЖДОМ запросе кабинета, ради чего и городился
          // Promise.all выше.
          .select(PROFILE_COLUMNS)
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

  // Колонка `market` приехала миграцией 20260804_0004. В окружении без неё
  // PostgREST валит 42703 на ВЕСЬ select — то есть вместе с ролью, — и 503 ниже
  // положил бы весь /api/client/*, включая RU-кабинет, из-за колонки, которая
  // нужна одному ENG. Поэтому ровно этот код не считаем сбоем, а перечитываем
  // строку прежним набором колонок: рынок тогда неизвестен и разрешится по
  // пути/хосту, а всё остальное работает как до правки. Риск назван в
  // `hypothesisEngine/apiGuards.ts` (шапка requireEngMarket) — это его закрытие.
  const profileRes =
    profileFirstRes.error?.code === PG_UNDEFINED_COLUMN
      ? await withApiTiming(
          // Отдельное имя спана: в замерах видно, что окружение без колонки
          // платит второй round-trip, и прежний `client.auth.profile` не
          // начинает молча считаться дважды.
          'client.auth.profile.legacy',
          () => admin.from('profiles').select(PROFILE_COLUMNS_LEGACY).eq('id', user.id).single(),
          timingMeta,
        )
      : profileFirstRes;

  // Инфраструктурный сбой чтения профиля (таймаут/блип main-БД) — это НЕ
  // «профиля нет». Без этой проверки profile=null превращал role в null, и
  // клиент получал «Forbidden» из-за секундного блипа БД. PGRST116 («строк
  // нет») — легитимное отсутствие профиля, идёт прежним путём (403 ниже).
  if (profileRes.error && profileRes.error.code !== 'PGRST116') {
    // Рынка профиля тут нет по определению — его и не читаем: путь и Host
    // отвечают на вопрос «чей кабинет» без БД (см. requestMarket).
    return { error: jsonError(UNAVAILABLE_TEXT[requestMarket(req)], 503) };
  }

  const profile = (profileRes.data ?? null) as ClientProfileRow | null;
  const market = requestMarket(req, profile?.market);

  const role = profile?.role ?? null;
  if (role !== 'client' && role !== 'admin') {
    return { error: jsonError('Forbidden', 403) };
  }

  // Демо-вкладка (?demo=1, помечена заголовком фронтом — см. clientDemo/tabDemoMode):
  // пользователь ЗАЛОГИНЕН как обычно (сессия проверена выше), но этот запрос
  // обслуживается как демо: фикстуры вместо реальных данных. Даёт возможность
  // держать демо и рабочий кабинет в соседних вкладках одного браузера (одна
  // сессия, два режима). Чужих данных не открывает: роуты при isDemo идут в
  // serveClientDemo и БД не трогают; мутации режутся тем же блоком ниже.
  const isTabDemo = req.headers.get(TAB_DEMO_HEADER) === '1';

  const isDemo = isTabDemo || profile?.is_demo === true;

  // Демо-аккаунт строго read-only. Любой мутирующий запрос режем здесь,
  // централизованно — ни один клиентский роут физически не сможет ничего
  // изменить под демо-юзером (сколько бы человек одновременно ни зашло).
  // Исключение — read-only POST'ы (отчёт, поиск): они отдают фикстуру.
  if (
    isDemo &&
    MUTATING_METHODS.has(req.method) &&
    !DEMO_READONLY_POST_PATHS.has(req.nextUrl.pathname)
  ) {
    return { error: demoReadonlyError(market) };
  }

  // Демо-вкладке права доступа не нужны (фикстуры), instantly-БД не дёргаем
  // и от её блипов не зависим.
  if (isTabDemo) {
    return {
      auth: {
        userId: user.id,
        accessRows: [],
        isDemo: true,
        market,
      },
    };
  }

  // Инфраструктурный сбой чтения прав доступа (блип instantly-БД, 20с-таймаут
  // PostgREST). Раньше ошибка глоталась → accessRows=[] → роуты честно отвечали
  // «данных нет», и клиент видел «Кампаний пока нет» вместо ошибки с ретраем
  // (инцидент 15.07). Демо не режем: демо-роуты отдают фикстуры, rows не нужны.
  if (!isDemo && rowsRes.error) {
    return { error: jsonError(UNAVAILABLE_TEXT[market], 503) };
  }

  const rows = rowsRes.data;

  return {
    auth: {
      userId: user.id,
      accessRows: (rows ?? []) as ClientAccessRow[],
      isDemo,
      market,
    },
  };
}

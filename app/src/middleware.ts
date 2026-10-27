import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { DEFAULT_LOCALE, LOCALE_COOKIE, normalizeLocale } from '@/lib/i18n'
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient'
import { isInternalRole } from '@/lib/roles'
import { MAIN_APP_HOST, isEngAppHost, type ClientMarket } from '@/lib/engMarket'
import type { UserRole } from '@/types'

const ROLE_COOKIE = 'x-portal-role'
const ROLE_COOKIE_MAX_AGE = 30 * 60
const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 30
// Страница аккаунта ENG-кабинета — единственный адрес, который вход на
// ENG-хосте возвращает после себя (`?next=`, тот же литерал принимает
// app/login/page.tsx). Ниже: гостя с неё уводим на /login с этим next,
// вошедшего клиента с /login?next=<он> — прямо на неё. Только ENG-хост.
const ENG_ACCOUNT_PATH = '/client/eng/account'

// Формат куки: userId:role:market. Сегмент market добавлен позже — старые
// куки userId:role остаются валидными: роль извлекается, market считается
// неизвестным и дочитывается из profiles точечно (см. decodeMarketCache).
function encodeRoleCache(userId: string, role: string, market?: ClientMarket | null): string {
  return market ? `${userId}:${role}:${market}` : `${userId}:${role}`
}

function decodeRoleCache(raw: string, currentUserId: string): string | null {
  const sep = raw.indexOf(':')
  if (sep === -1) return null
  if (raw.substring(0, sep) !== currentUserId) return null
  const rest = raw.substring(sep + 1)
  const sep2 = rest.indexOf(':')
  const role = sep2 === -1 ? rest : rest.substring(0, sep2)
  return role || null
}

// Третий сегмент куки роли. null = market в куке нет (старый формат) или
// значение мусорное — тогда читаем profiles.
function decodeMarketCache(raw: string, currentUserId: string): ClientMarket | null {
  const sep = raw.indexOf(':')
  if (sep === -1) return null
  if (raw.substring(0, sep) !== currentUserId) return null
  const rest = raw.substring(sep + 1)
  const sep2 = rest.indexOf(':')
  if (sep2 === -1) return null
  const market = rest.substring(sep2 + 1)
  return market === 'eng' || market === 'ru' ? market : null
}

// Public / external API: authenticate with their OWN secret/signature or are
// genuinely public. They skip the staff-only gate and enforce their own auth.
// (The ai-caller Telegram webhook is excluded in its own block above.)
// External webhook receivers (Instantly / Telegram / Unipile / YooKassa, etc.)
// are called WITHOUT a user JWT and must validate their own secret/signature.
// Exact list, not "path contains /webhook": under the old pattern any staff
// route with a dynamic segment set to `webhook` became public (audit
// 26.10.2026). The `.../webhooks` (plural) management routes stay staff-only.
// A new webhook receiver must be added here.
const PUBLIC_WEBHOOK_PATHS = new Set([
  '/api/amo/funnel-guard/webhook',
  '/api/amo/funnel-guard/webhook/reconcile',
  '/api/invoices/webhook',
  '/api/telegram/agent/webhook',
  '/api/telegram/client-replies/webhook',
  '/api/telegram/handoff/webhook',
  '/api/tools/li-outreach/webhook',
  '/api/tools/tg-transcribe/webhook',
])

function isPublicApiPath(p: string): boolean {
  if (PUBLIC_WEBHOOK_PATHS.has(p) || p.startsWith('/api/instantly/webhook/')) return true
  return (
    p === '/api/signup' ||
    p === '/api/auth/forgot-password' || // unauthenticated self-service password reset from /login
    p === '/api/demo-lead' || // public landing demo-gate lead capture
    p === '/api/health' ||
    p.startsWith('/api/partner/') || // external pull-API, auth'd by PARTNER_API_KEY
    // Bench — внешняя витрина инструментов для подрядчиков. Авторизуется
    // собственным ключом (bench_live_*) и работает от имени учётки-робота,
    // поэтому штатный staff-only гейт ей не подходит: пользовательского JWT
    // у неё нет. Свою проверку она делает в lib/bench/auth.ts на КАЖДОМ
    // запросе, без кэша, чтобы отзыв ключа действовал немедленно.
    p.startsWith('/api/bench/') ||
    p.startsWith('/api/telegram/verify') ||
    p.startsWith('/api/telegram/link') ||
    p.startsWith('/api/lead-board/') || // гостевая таблица лидов — auth по токену
    p.startsWith('/api/cron/')
  )
}

// API the CLIENT portal legitimately calls (incl. OAuth callbacks under
// /api/client). Routes enforce their own client/demo auth (requireClientAuth
// blocks demo mutations). Verified by tracing every fetch from src/app/client/**
// and its imported components (sidebar, global translator, parser/base-constructor
// tool views). Everything else under /api is staff-only. NOTE: exact-or-slash
// prefixes are deliberate — `startsWith('/api/parsers/hh')` would wrongly also
// allowlist the INTERNAL `/api/parsers/hh-archive`.
function isClientApiPath(p: string): boolean {
  return (
    p.startsWith('/api/client/') ||
    p === '/api/user/locale' ||
    p === '/api/portal/translate' ||
    p === '/api/brief-scoring/parse-pdf' ||
    p === '/api/parsers/search' ||
    p.startsWith('/api/parsers/search/') ||
    p === '/api/parsers/hh' ||
    p.startsWith('/api/parsers/hh/') ||
    p === '/api/parsers/yandexmaps' ||
    p.startsWith('/api/parsers/yandexmaps/') ||
    p === '/api/tools/base-constructor' ||
    p.startsWith('/api/tools/base-constructor/') ||
    p === '/api/tools/email-sequence-v2' ||
    p.startsWith('/api/tools/email-sequence-v2/')
  )
}

// Cron callers authenticate with CRON_SECRET (query ?secret=, x-vercel-cron-secret
// header, or Authorization: Bearer <secret>) — not a user JWT. Matches the check
// used by /api/cron/* handlers so those (and tool collectors triggered by cron)
// pass the gate without an internal user.
function hasValidCronSecret(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const provided =
    request.nextUrl.searchParams.get('secret') ??
    request.headers.get('x-vercel-cron-secret') ??
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    null
  return provided === secret
}

/**
 * Staff-only gate for internal /api/* routes. Middleware historically did NOT
 * gate /api/* by role, and many internal routes only did getUser() — or had no
 * auth at all, using a service-role client — so a client/demo JWT (or even an
 * anonymous request) could drive them: real phone calls, paid LLM/enrichment
 * spend, proprietary-data export, cross-tenant writes. This closes the whole
 * class at one point: allow a valid CRON_SECRET (cron callers) or an internal,
 * non-demo user; deny everyone else. Fail-CLOSED: anonymous / client / demo /
 * unverifiable => 403. Public and client-facing paths are allowlisted by the
 * caller before this runs.
 */
async function denyApiForNonInternal(request: NextRequest): Promise<NextResponse | null> {
  if (hasValidCronSecret(request)) return null

  // Auth source priority: Bearer header (API fetches) or `?t=` query token
  // (file-download navigations carry the JWT in the query, not a header).
  // Otherwise fall back to the session cookies — top-level browser navigations
  // send cookies, not a Bearer header.
  const queryToken = request.nextUrl.searchParams.get('t')
  const token =
    getBearerToken(request.headers.get('authorization')) ??
    (queryToken && queryToken.startsWith('eyJ') ? queryToken : null)

  try {
    let sb
    if (token) {
      sb = createAuthedSupabaseClient(token)
    } else {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
      const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      if (!supabaseUrl || !supabaseAnonKey) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
      sb = createServerClient(supabaseUrl, supabaseAnonKey, {
        cookies: {
          get(name: string) {
            return request.cookies.get(name)?.value
          },
          set() {},
          remove() {},
        },
      })
    }
    const { data: { user } } = await sb.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { data: profile } = await sb
      .from('profiles')
      .select('role, is_demo')
      .eq('id', user.id)
      .single()
    if (profile && profile.is_demo !== true && isInternalRole((profile.role ?? null) as UserRole | null)) {
      return null
    }
    return NextResponse.json({ error: 'Forbidden', code: 'INTERNAL_ONLY' }, { status: 403 })
  } catch {
    return NextResponse.json({ error: 'Forbidden', code: 'INTERNAL_ONLY' }, { status: 403 })
  }
}

export async function middleware(request: NextRequest) {
  const response = NextResponse.next({
    request: {
      headers: request.headers,
    },
  })

  const pathname = request.nextUrl.pathname
  const isMaintenanceMode = process.env.MAINTENANCE_MODE === 'true'
  const maintenanceBypassToken = process.env.MAINTENANCE_BYPASS_TOKEN
  const bypassCookieName = 'portal_maintenance_bypass'

  if (isMaintenanceMode) {
    const bypassCookie = request.cookies.get(bypassCookieName)?.value
    const bypassFromQuery = request.nextUrl.searchParams.get('maintenance_bypass')
    const hasValidBypassToken =
      Boolean(maintenanceBypassToken) && bypassFromQuery === maintenanceBypassToken
    const hasBypassAccess = bypassCookie === '1' || hasValidBypassToken

    if (hasValidBypassToken) {
      response.cookies.set({
        name: bypassCookieName,
        value: '1',
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
      })
    }

    const maintenanceAllowedPath =
      pathname === '/maintenance' ||
      pathname.startsWith('/_next') ||
      pathname === '/favicon.ico' ||
      pathname.startsWith('/api')

    if (!maintenanceAllowedPath && !hasBypassAccess) {
      return NextResponse.redirect(new URL('/maintenance', request.url))
    }

    if (pathname === '/maintenance' && hasBypassAccess) {
      return NextResponse.redirect(new URL('/', request.url))
    }
  } else if (pathname === '/maintenance') {
    // Deploy завершился, MAINTENANCE_MODE снят, но URL пользователя всё ещё
    // /maintenance (его туда редиректил middleware пока MAINTENANCE_MODE был
    // включён). Auto-refresh страницы /maintenance бы бесконечно её же и
    // показывал — поэтому при выключенном maintenance отбрасываем на корень.
    return NextResponse.redirect(new URL('/', request.url))
  }

  if (pathname.startsWith('/api/ai-caller')) {
    // Telegram/VAPI webhook is hit by external services (no user JWT) — skip the
    // staff-only gate for it; everything else in the namespace is enforced.
    if (!pathname.startsWith('/api/ai-caller/telegram/webhook')) {
      const denied = await denyApiForNonInternal(request)
      if (denied) return denied
    }
    const referer = request.headers.get('referer') ?? ''
    if (referer.includes('/tools/ai-caller-v2')) {
      const headers = new Headers(request.headers)
      headers.set('x-ai-caller-provider', 'elevenlabs')
      return NextResponse.next({ request: { headers } })
    }
    return response
  }

  if (pathname.startsWith('/api')) {
    // Default-deny for /api/*: public (own-secret/webhook/cron) and client-facing
    // paths are allowlisted; everything else is internal staff-only. This is the
    // systemic fix — middleware never gated /api by role, so any client/demo (or
    // anonymous) token reached internal routes that only did getUser() or no auth.
    if (isPublicApiPath(pathname) || isClientApiPath(pathname)) {
      return response
    }
    const denied = await denyApiForNonInternal(request)
    if (denied) return denied
    return response
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('Missing Supabase environment variables. Please check your .env.local file.');
    if (pathname === '/team') return NextResponse.redirect(new URL('/', request.url));
    return response;
  }

  const supabase = createServerClient(
    supabaseUrl,
    supabaseAnonKey,
    {
      cookies: {
        get(name: string) {
          return request.cookies.get(name)?.value
        },
        set(name: string, value: string, options: CookieOptions) {
          // Важно: не пересоздаём response, иначе теряем уже установленные куки
          // (LOCALE_COOKIE, ROLE_COOKIE и т.п.). Просто синхронизируем входящие
          // куки запроса и пишем в исходящий response — supabase-ssr делает
          // авторефреш сессии и обновляет sb-* куки, и они должны долететь
          // до клиента, иначе он будет сидеть со стэйл-токеном и снова 401.
          request.cookies.set({ name, value, ...options })
          response.cookies.set({ name, value, ...options })
        },
        remove(name: string, options: CookieOptions) {
          request.cookies.set({ name, value: '', ...options })
          response.cookies.set({ name, value: '', ...options })
        },
      },
    }
  )

  try {
    // ВАЖНО: getUser() ходит в GoTrue и сам рефрешит токен по refresh_token.
    // getSession() читает только cookie и не рефрешит — после истечения
    // GOTRUE_JWT_EXP (на self-hosted = 1 час) это приводит к ложному
    // редиректу на /login при следующем переходе.
    const { data: { user } } = await supabase.auth.getUser()
    const isPublicPath =
      pathname === '/maintenance' ||
      pathname === '/login' ||
      pathname === '/signup' ||
      pathname === '/offer' ||
      pathname === '/consent' ||
      pathname === '/privacy' ||
      pathname === '/demo' ||
      pathname.startsWith('/api/signup') ||
      pathname.startsWith('/api/telegram/verify') ||
      pathname.startsWith('/api/telegram/link') ||
      pathname.startsWith('/leads-board/')

    if (!user && !isPublicPath) {
      // ENG-хост, гость открыл страницу аккаунта (закладка, ссылка из письма):
      // на вход с next, иначе после входа он попадёт в кабинет, а не обратно
      // на Account. Точное совпадение пути; любой другой путь и любой другой
      // хост — прежний голый /login.
      if (pathname === ENG_ACCOUNT_PATH && isEngAppHost(request.headers.get('host'))) {
        return NextResponse.redirect(new URL(`/login?next=${ENG_ACCOUNT_PATH}`, request.url))
      }
      return NextResponse.redirect(new URL('/login', request.url))
    }

    let authoritativeTeamProfile: {
      role: string
      locale: string | null
      isDemo: boolean
    } | null = null

    if (user && pathname === '/team') {
      try {
        const { data: profile, error: profileError } = await supabase
          .from('profiles')
          .select('role, locale, is_demo')
          .eq('id', user.id)
          .single()

        if (
          profileError
          || !profile
          || typeof profile.role !== 'string'
          || !profile.role
        ) {
          console.error(
            '[middleware] Failed to verify authoritative /team access:',
            profileError ?? new Error('Profile role is missing'),
          )
          return NextResponse.redirect(new URL('/', request.url))
        }

        authoritativeTeamProfile = {
          role: profile.role,
          locale: typeof profile.locale === 'string' ? profile.locale : null,
          isDemo: profile.is_demo === true,
        }
      } catch (profileError) {
        console.error(
          '[middleware] Failed to verify authoritative /team access:',
          profileError,
        )
        return NextResponse.redirect(new URL('/', request.url))
      }
    }

    let userRole: string | null = null
    let userLocale = DEFAULT_LOCALE
    // Сырое значение куки роли — ниже нужно и для market-сегмента.
    const roleCookieRaw = request.cookies.get(ROLE_COOKIE)?.value ?? ''

    if (user) {
      const raw = roleCookieRaw
      const cached = authoritativeTeamProfile
        ? authoritativeTeamProfile.role
        : (raw ? decodeRoleCache(raw, user.id) : null)
      const rawLocaleCookie = request.cookies.get(LOCALE_COOKIE)?.value
      const cachedLocale = normalizeLocale(rawLocaleCookie)
      userLocale = cachedLocale
      if (cached) {
        userRole = cached
        // На cache-HIT по роли локаль берём из уже прочитанной куки, если она
        // есть, и НЕ ходим в БД. И GET, и PUT /api/user/locale переписывают
        // LOCALE_COOKIE на актуальное значение из profiles, а клиентский layout
        // дёргает GET /api/user/locale при каждом монтировании — поэтому кука
        // всегда синхронна с profiles.locale. Это убирает лишний кросс-VPS
        // round-trip к profiles на КАЖДОЙ навигации. Если куки локали нет
        // (первый заход / чистка кук) — падаем в БД, чтобы не потерять локаль.
        if (authoritativeTeamProfile) {
          userLocale = normalizeLocale(authoritativeTeamProfile.locale)
        } else if (rawLocaleCookie) {
          userLocale = cachedLocale
        } else {
          const { data: localeProfile } = await supabase
            .from('profiles')
            .select('locale')
            .eq('id', user.id)
            .single()
          userLocale = normalizeLocale(localeProfile?.locale)
        }
      } else {
        const { data: profile } = await supabase
          .from('profiles')
          .select('role, locale')
          .eq('id', user.id)
          .single()
        userRole = profile?.role ?? null
        userLocale = normalizeLocale(profile?.locale)
        if (userRole) {
          response.cookies.set({
            name: ROLE_COOKIE,
            value: encodeRoleCache(user.id, userRole),
            httpOnly: true,
            sameSite: 'lax',
            path: '/',
            maxAge: ROLE_COOKIE_MAX_AGE,
          })
        }
      }
      response.cookies.set({
        name: LOCALE_COOKIE,
        value: userLocale,
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: LOCALE_COOKIE_MAX_AGE,
      })
    } else {
      response.cookies.set({
        name: LOCALE_COOKIE,
        value: DEFAULT_LOCALE,
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: LOCALE_COOKIE_MAX_AGE,
      })
    }

    // --- Продуктовое разделение по хосту: ENG-кабинет (app.outreachos.xyz) ---
    // Маркет профиля нужен далеко не на каждом запросе: только на ENG-хосте
    // (кого вообще пускаем) и у клиентов на /client/* (гейты ENG-раздела).
    // Читаем точечно по образцу is_demo ниже; кэш — третий сегмент ROLE_COOKIE.
    const isEngHost = isEngAppHost(request.headers.get('host'))
    const isEngCabinetPath = pathname === '/client/eng' || pathname.startsWith('/client/eng/')
    let userMarket: ClientMarket | null = null
    if (user && (isEngHost || (userRole === 'client' && pathname.startsWith('/client')))) {
      userMarket = roleCookieRaw ? decodeMarketCache(roleCookieRaw, user.id) : null
      if (!userMarket) {
        // Колонка profiles.market появилась в 20260804_0004; до её наката
        // select вернёт ошибку (не throw) → marketProfile=null → 'ru',
        // т.е. прежнее поведение. Куку в этом случае не трогаем.
        const { data: marketProfile } = await supabase
          .from('profiles')
          .select('market')
          .eq('id', user.id)
          .single()
        userMarket = marketProfile?.market === 'eng' ? 'eng' : 'ru'
        if (userRole && marketProfile) {
          response.cookies.set({
            name: ROLE_COOKIE,
            value: encodeRoleCache(user.id, userRole, userMarket),
            httpOnly: true,
            sameSite: 'lax',
            path: '/',
            maxAge: ROLE_COOKIE_MAX_AGE,
          })
        }
      }
    }

    // (г) ENG-хост — только ENG-мир: стаффа там быть не должно.
    if (isEngHost && user && userRole && userRole !== 'client') {
      return NextResponse.redirect(`https://${MAIN_APP_HOST}/`)
    }
    // (в) ru-клиент на ENG-хосте — его кабинет на основном хосте (сессия
    // per-domain, там он залогинится заново).
    if (isEngHost && user && userRole === 'client' && userMarket === 'ru') {
      return NextResponse.redirect(`https://${MAIN_APP_HOST}/`)
    }
    // Корень ENG-хоста: залогиненного eng-клиента — сразу в ENG-кабинет
    // (гостя на /login уже уводит общий guard выше).
    if (isEngHost && user && pathname === '/') {
      return NextResponse.redirect(new URL('/client/eng', request.url))
    }
    // (а) eng-клиент вне ENG-раздела → в ENG-кабинет (на любом хосте).
    // Исключение — чат поддержки /client/support: ENG-кабинет self-serve, и
    // его отказы ведут в Support. Страница говорит с eng-клиентом
    // по-английски (ENG-хост или рынок профиля — app/client/support), её API
    // (/api/client/support/*) сюда не доходит вовсе — /api/client/* отвечен
    // выше, рынок он не проверяет. RU-клиента правило (а) не касается.
    const isSupportPath = pathname === '/client/support' || pathname.startsWith('/client/support/')
    if (
      user
      && userRole === 'client'
      && userMarket === 'eng'
      && pathname.startsWith('/client')
      && !isEngCabinetPath
      && !isSupportPath
    ) {
      return NextResponse.redirect(new URL('/client/eng', request.url))
    }
    // (б) ru-клиент в ENG-разделе → обратно в RU-кабинет.
    if (user && userRole === 'client' && userMarket === 'ru' && isEngCabinetPath) {
      return NextResponse.redirect(new URL('/client', request.url))
    }

    // Demo accounts (role=client + is_demo) must be able to reach BOTH /signup (to
    // register a real account) and /login (to sign into one) — otherwise the two
    // guards below bounce them to /client (the "came from /demo, clicked Создать
    // аккаунт / Войти, landed back in the demo dashboard" bug). Compute the flag once
    // and honour it in both guards. Targeted is_demo read only on this rare path (a
    // logged-in client hitting /login or /signup).
    let isDemoOnAuthPage = false
    if (user && userRole === 'client' && (pathname === '/login' || pathname === '/signup')) {
      const { data: demoProfile } = await supabase
        .from('profiles')
        .select('is_demo')
        .eq('id', user.id)
        .single()
      isDemoOnAuthPage = demoProfile?.is_demo === true
    }

    // Авторизованного пользователя С РОЛЬЮ уводим с /login в его раздел.
    // Аккаунт без роли НЕ уводим — пусть остаётся на /login (внутрь портала
    // его всё равно не пустит default-deny ниже). Иначе был бы
    // редирект-цикл /login → / → /login. Демо на /login·/signup — исключение (см. выше).
    if (user && userRole && (pathname === '/login' || pathname === '/signup') && !isDemoOnAuthPage) {
      // ENG-хост: ссылка «Set your own password» из письма сброса
      // (/login?next=/client/eng/account) у того, кто ещё вошёл, ведёт сразу
      // на Account, а не в кабинет. Только eng-клиент (стафф и ru-клиента
      // ENG-хост уже увёл выше), только /login и только один точный next
      // (повторённый next отвергает и app/login/page.tsx).
      const loginNext = request.nextUrl.searchParams.getAll('next')
      if (
        isEngHost
        && userRole === 'client'
        && userMarket === 'eng'
        && pathname === '/login'
        && loginNext.length === 1
        && loginNext[0] === ENG_ACCOUNT_PATH
      ) {
        return NextResponse.redirect(new URL(ENG_ACCOUNT_PATH, request.url))
      }
      return NextResponse.redirect(
        new URL(userRole === 'client' ? '/client' : '/', request.url)
      )
    }

    // Default-deny для аккаунтов без роли. Саморегистрация закрыта
    // (см. app/login/page.tsx) — все аккаунты заводит админ и сразу
    // назначает роль. Пользователь без роли — это либо недопровиженный
    // аккаунт, либо остаток от старой открытой регистрации; внутрь портала
    // не пускаем. Публичные пути уже отсеяны через isPublicPath.
    if (user && !userRole && !isPublicPath) {
      return NextResponse.redirect(new URL('/login', request.url))
    }

    if (user && userRole === 'client') {
      const clientAllowed =
        isDemoOnAuthPage ||
        pathname.startsWith('/client') ||
        pathname === '/maintenance' ||
        pathname === '/consent' ||
        pathname === '/privacy' ||
        pathname.startsWith('/leads-board/')
      if (!clientAllowed) {
        return NextResponse.redirect(new URL('/client', request.url))
      }
    }

    if (
      user
      && pathname === '/team'
      && (
        authoritativeTeamProfile?.isDemo === true
        || !isInternalRole(userRole as UserRole | null)
      )
    ) {
      return NextResponse.redirect(new URL('/', request.url))
    }

    if (user && pathname.startsWith('/client')) {
      if (userRole !== 'client' && userRole !== 'admin') {
        return NextResponse.redirect(new URL('/', request.url))
      }
    }

    if (user && pathname.startsWith('/admin')) {
      if (userRole !== 'admin') {
        return NextResponse.redirect(new URL('/', request.url))
      }
    }

    if (user && pathname.startsWith('/billing-calendar')) {
      const allowedRoles = ['technician', 'lead', 'admin', 'director']
      if (!userRole || !allowedRoles.includes(userRole)) {
        return NextResponse.redirect(new URL('/', request.url))
      }
    }

    // Календарь технички — только админ: суммы по инфраструктуре студии.
    if (user && pathname.startsWith('/tech-calendar')) {
      if (userRole !== 'admin') {
        return NextResponse.redirect(new URL('/', request.url))
      }
    }

    // Дашборд нагрузки почт — только руководство (lead/director/admin, = isLead).
    // Оценка эффективности специалистов, не для рядовых ролей.
    if (user && pathname.startsWith('/analytics/mailbox-load')) {
      const allowedRoles = ['lead', 'director', 'admin']
      if (!userRole || !allowedRoles.includes(userRole)) {
        return NextResponse.redirect(new URL('/', request.url))
      }
    }

    return response
  } catch (err) {
    // Если GoTrue/PostgREST недоступен — НЕ выкидываем пользователя,
    // отдаём response как есть. Лучше показать ошибку загрузки внутри
    // приложения, чем мигом на /login.
    console.error('[middleware] Supabase error, degrading gracefully:', err)
    if (pathname === '/team') return NextResponse.redirect(new URL('/', request.url))
    return response
  }
}

export const config = {
  // `/api/:path*` отдельно: исключение картинок по расширению действовало и на
  // API, и `/api/<route>/<id>.png` проходил мимо staff-проверки (аудит
  // 26.10.2026). API, отдающих картинки по такому адресу, в портале нет.
  matcher: ['/api/:path*', '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}

import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { DEFAULT_LOCALE, LOCALE_COOKIE, normalizeLocale } from '@/lib/i18n'
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient'
import { isInternalRole } from '@/lib/roles'
import type { UserRole } from '@/types'

const ROLE_COOKIE = 'x-portal-role'
const ROLE_COOKIE_MAX_AGE = 30 * 60
const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 30

function encodeRoleCache(userId: string, role: string): string {
  return `${userId}:${role}`
}

function decodeRoleCache(raw: string, currentUserId: string): string | null {
  const sep = raw.indexOf(':')
  if (sep === -1) return null
  if (raw.substring(0, sep) !== currentUserId) return null
  return raw.substring(sep + 1) || null
}

// Public / external API: authenticate with their OWN secret/signature or are
// genuinely public. They skip the staff-only gate and enforce their own auth.
// (The ai-caller Telegram webhook is excluded in its own block above.)
function isPublicApiPath(p: string): boolean {
  // External webhook receivers (Instantly / Telegram / Unipile / YooKassa, etc.)
  // are called WITHOUT a user JWT and must validate their own secret/signature.
  // Matches `.../webhook` and `.../webhook/...` but NOT the `.../webhooks` (plural)
  // management routes, which stay staff-only.
  if (p.endsWith('/webhook') || p.includes('/webhook/')) return true
  return (
    p === '/api/signup' ||
    p === '/api/auth/forgot-password' || // unauthenticated self-service password reset from /login
    p === '/api/demo-lead' || // public landing demo-gate lead capture
    p === '/api/health' ||
    p.startsWith('/api/partner/') || // external pull-API, auth'd by PARTNER_API_KEY
    p.startsWith('/api/telegram/verify') ||
    p.startsWith('/api/telegram/link') ||
    p.startsWith('/api/database-review/guest/') ||
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
      pathname === '/demo' ||
      pathname.startsWith('/api/signup') ||
      pathname.startsWith('/api/telegram/verify') ||
      pathname.startsWith('/api/telegram/link') ||
      pathname.startsWith('/review/base/')

    if (!user && !isPublicPath) {
      return NextResponse.redirect(new URL('/login', request.url))
    }

    let userRole: string | null = null
    let userLocale = DEFAULT_LOCALE

    if (user) {
      const raw = request.cookies.get(ROLE_COOKIE)?.value ?? ''
      const cached = raw ? decodeRoleCache(raw, user.id) : null
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
        if (rawLocaleCookie) {
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

    // Авторизованного пользователя С РОЛЬЮ уводим с /login в его раздел.
    // Аккаунт без роли НЕ уводим — пусть остаётся на /login (внутрь портала
    // его всё равно не пустит default-deny ниже). Иначе был бы
    // редирект-цикл /login → / → /login.
    if (user && userRole && (pathname === '/login' || pathname === '/signup')) {
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
        pathname.startsWith('/client') ||
        pathname === '/maintenance' ||
        pathname.startsWith('/review/base/')
      if (!clientAllowed) {
        return NextResponse.redirect(new URL('/client', request.url))
      }
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

    return response
  } catch (err) {
    // Если GoTrue/PostgREST недоступен — НЕ выкидываем пользователя,
    // отдаём response как есть. Лучше показать ошибку загрузки внутри
    // приложения, чем мигом на /login.
    console.error('[middleware] Supabase error, degrading gracefully:', err)
    return response
  }
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}

import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { DEFAULT_LOCALE, LOCALE_COOKIE, normalizeLocale } from '@/lib/i18n'

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
    const referer = request.headers.get('referer') ?? ''
    if (referer.includes('/tools/ai-caller-v2')) {
      const headers = new Headers(request.headers)
      headers.set('x-ai-caller-provider', 'elevenlabs')
      return NextResponse.next({ request: { headers } })
    }
    return response
  }

  if (pathname.startsWith('/api')) {
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
      const cachedLocale = normalizeLocale(request.cookies.get(LOCALE_COOKIE)?.value)
      userLocale = cachedLocale
      if (cached) {
        userRole = cached
        const { data: localeProfile } = await supabase
          .from('profiles')
          .select('locale')
          .eq('id', user.id)
          .single()
        userLocale = normalizeLocale(localeProfile?.locale)
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
    if (user && userRole && pathname === '/login') {
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

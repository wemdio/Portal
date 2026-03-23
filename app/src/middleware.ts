import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({
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
          request.cookies.set({
            name,
            value,
            ...options,
          })
          response = NextResponse.next({
            request: {
              headers: request.headers,
            },
          })
          response.cookies.set({
            name,
            value,
            ...options,
          })
        },
        remove(name: string, options: CookieOptions) {
          request.cookies.set({
            name,
            value: '',
            ...options,
          })
          response = NextResponse.next({
            request: {
              headers: request.headers,
            },
          })
          response.cookies.set({
            name,
            value: '',
            ...options,
          })
        },
      },
    }
  )

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

  if (user && pathname === '/login') {
    return NextResponse.redirect(new URL('/', request.url))
  }

  // Fetch role once for all role-based guards below
  let userRole: string | null = null
  const needsRoleCheck =
    user &&
    (pathname.startsWith('/admin') ||
     pathname.startsWith('/billing-calendar') ||
     pathname.startsWith('/client') ||
     pathname === '/' ||
     // any internal page a client should not reach
     (!pathname.startsWith('/login') && !pathname.startsWith('/review/')))

  if (user && needsRoleCheck) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()
    userRole = profile?.role ?? null
  }

  // Client users: redirect to /client from any internal page
  if (user && userRole === 'client') {
    const clientAllowed =
      pathname.startsWith('/client') ||
      pathname === '/login' ||
      pathname === '/maintenance' ||
      pathname.startsWith('/review/base/')
    if (!clientAllowed) {
      return NextResponse.redirect(new URL('/client', request.url))
    }
  }

  // /client routes: require client role or admin (for preview)
  if (user && pathname.startsWith('/client')) {
    if (userRole !== 'client' && userRole !== 'admin') {
      return NextResponse.redirect(new URL('/', request.url))
    }
  }

  // Protect admin routes - only admin role can access
  if (user && pathname.startsWith('/admin')) {
    if (userRole !== 'admin') {
      return NextResponse.redirect(new URL('/', request.url))
    }
  }

  // Protect billing-calendar routes - only technician, lead, admin, director
  if (user && pathname.startsWith('/billing-calendar')) {
    const allowedRoles = ['technician', 'lead', 'admin', 'director']
    if (!userRole || !allowedRoles.includes(userRole)) {
      return NextResponse.redirect(new URL('/', request.url))
    }
  }

  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { blockDemo } from '@/lib/auth/blockDemo';
import { DEFAULT_LOCALE, LOCALE_COOKIE, normalizeLocale, type Locale } from '@/lib/i18n';

export const dynamic = 'force-dynamic';

async function getUser(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return null;
  try {
    const supabase = createAuthedSupabaseClient(token);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return user ? { user, supabase } : null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  try {
    const auth = await getUser(req);
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data, error } = await auth.supabase
      .from('profiles')
      .select('locale')
      .eq('id', auth.user.id)
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const locale = normalizeLocale(data?.locale);
    const response = NextResponse.json({ locale });
    response.cookies.set({
      name: LOCALE_COOKIE,
      value: locale,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });
    return response;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}

export async function PUT(req: NextRequest) {
  try {
    const auth = await getUser(req);
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // Демо-аккаунт ОБЩИЙ: без этого гейта любой посетитель демо записывал locale
    // в его профиль и «переключал язык» ВСЕМ сразу (инцидент 12.07: locale=en +
    // read-only перевод под демо = вечный белый оверлей у всех, включая /login).
    const demo = await blockDemo(auth.supabase, auth.user.id);
    if (demo) return demo;

    let body: { locale?: Locale };
    try {
      body = (await req.json()) as { locale?: Locale };
    } catch {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
    }

    const locale = normalizeLocale(body.locale ?? DEFAULT_LOCALE);
    const { error } = await auth.supabase
      .from('profiles')
      .update({ locale })
      .eq('id', auth.user.id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const response = NextResponse.json({ ok: true, locale });
    response.cookies.set({
      name: LOCALE_COOKIE,
      value: locale,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });
    return response;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}

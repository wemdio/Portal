import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';
import { sendDemoLeadTelegramAlert } from '@/lib/demoLead/notify';
import { CLIENT_LOCALE_COOKIE, normalizeClientLocale } from '@/lib/clientI18n';
import { TARIFF_LAUNCH } from '@/lib/tariffPricing';

export const dynamic = 'force-dynamic';

/**
 * Open self-signup endpoint. Creates a Supabase auth user with the role
 * already set to 'client' and an inactive client_tariffs row so the user
 * lands in their portal in "demo" mode (status=inactive). They pay later
 * from /client/tariff. No email confirmation flow — email_confirm=true
 * marks the address as already confirmed (no Supabase email sent).
 *
 * Collects contact fields (name + company required, phone/telegram optional),
 * persists them on the profile, and pings the team on Telegram (source=register)
 * so a new registration is treated as a sales lead like the landing forms.
 */
function isEmailLike(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/**
 * Campaign attribution stashed by the landing in a parent-domain cookie
 * (Domain=outreachos.pro), so it survives the hop to app.outreachos.pro — both
 * the direct landing→/signup path and landing→/demo→…→«Зарегистрироваться». The
 * cookie rides the same-origin signup fetch; we read + whitelist it here.
 * Best-effort: any parse failure just means no attribution, never a failed signup.
 */
const UTM_COOKIE = 'oos_utm';
const UTM_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'referrer', 'landing', 'ts'] as const;
function readSignupUtm(req: NextRequest): Record<string, string> | null {
  const raw = req.cookies.get(UTM_COOKIE)?.value;
  if (!raw) return null;
  try {
    // Next.js RequestCookies already URL-decodes the value once on read
    // (parseCookie → decodeURIComponent); the landing encodes it once on set, so
    // the round-trip is balanced — parse as-is. A second decodeURIComponent here
    // would throw URIError on any literal '%' (e.g. utm_campaign=50%off) and drop
    // the whole attribution silently.
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object') return null;
    const out: Record<string, string> = {};
    for (const k of UTM_FIELDS) {
      const v = obj[k];
      if (typeof v === 'string' && v) out[k] = v.slice(0, 300);
    }
    return Object.keys(out).length ? out : null;
  } catch (err) {
    // Malformed / foreign cookie — best-effort: no attribution, never a failed signup.
    // Logged so a silent attribution loss stays observable instead of invisible.
    void logError('signup.utm_parse_failed', err);
    return null;
  }
}

export async function POST(req: NextRequest) {
  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  let body: {
    email?: string; password?: string;
    full_name?: string; company?: string; phone?: string; telegram?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Невалидный JSON' }, { status: 400 });
  }

  const email = (body.email ?? '').trim().toLowerCase();
  const password = body.password ?? '';
  const fullName = (body.full_name ?? '').trim();
  const company = (body.company ?? '').trim();
  const phone = (body.phone ?? '').trim();
  const telegram = (body.telegram ?? '').trim();
  const utm = readSignupUtm(req);
  const locale = normalizeClientLocale(req.cookies.get(CLIENT_LOCALE_COOKIE)?.value);

  if (!email || !isEmailLike(email)) {
    return NextResponse.json({ error: 'Введите корректный email' }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: 'Пароль должен быть от 8 символов' }, { status: 400 });
  }
  if (!fullName || fullName.length > 200) {
    return NextResponse.json({ error: 'Укажите имя' }, { status: 400 });
  }
  if (!company || company.length > 200) {
    return NextResponse.json({ error: 'Укажите компанию' }, { status: 400 });
  }
  if (phone.length > 50) return NextResponse.json({ error: 'Слишком длинный телефон' }, { status: 400 });
  if (telegram.length > 100) return NextResponse.json({ error: 'Слишком длинный telegram' }, { status: 400 });

  // Триггер public.handle_new_user (см. supabase/migrations/20260204_0002_*)
  // автоматически создаёт строку в profiles при INSERT в auth.users.
  // Он читает role из raw_user_meta_data — поэтому передаём user_metadata,
  // а сами в profiles не лезем (иначе primary key conflict — что и было
  // в проде 23.06: «Ошибка создания профиля», 500).
  const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { role: 'client' },
  });

  if (createErr || !created?.user) {
    const msg = createErr?.message ?? 'Ошибка создания аккаунта';
    if (/already (registered|exists)|duplicate/i.test(msg)) {
      return NextResponse.json({ error: 'Аккаунт с таким email уже существует' }, { status: 409 });
    }
    await logError('signup.create_user_failed', createErr, { email });
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const userId = created.user.id;

  // Defense-in-depth: если триггер по какой-то причине не сработал или
  // сработал с role='technician' (старый формат raw_user_meta_data) — добиваем
  // нужную роль через update. Идемпотентно: если уже client — no-op.
  const { error: profileErr } = await supabaseAdmin
    .from('profiles')
    .update({
      role: 'client',
      locale,
      full_name: fullName,
      company,
      phone: phone || null,
      telegram: telegram || null,
      signup_utm: utm,
    })
    .eq('id', userId);
  if (profileErr) {
    await logError('signup.profile_update_failed', profileErr, { userId });
    return NextResponse.json({ error: 'Ошибка обновления профиля' }, { status: 500 });
  }

  const { error: tariffErr } = await supabaseAdmin
    .from('client_tariffs')
    .insert({
      user_id: userId,
      tariff_type: TARIFF_LAUNCH,
      is_active: false,
      payment_locked: false,
    });
  if (tariffErr) {
    await logError('signup.tariff_insert_failed', tariffErr, { userId });
    return NextResponse.json({ error: 'Ошибка инициализации тарифа' }, { status: 500 });
  }

  await logAudit('signup.created', `New client signed up: ${email}`, { userId, email });

  // Treat a new registration as a sales lead — best-effort TG ping (never throws).
  await sendDemoLeadTelegramAlert({
    name: fullName,
    email,
    phone: phone || null,
    telegram: telegram || null,
    company,
    source: 'register',
    utm,
    referrer: utm?.referrer ?? null,
  });

  return NextResponse.json({ ok: true, user_id: userId }, { status: 201 });
}

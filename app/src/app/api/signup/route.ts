import { NextRequest, NextResponse, after } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError, logWarn } from '@/lib/loggerServer';
import { sendDemoLeadTelegramAlert } from '@/lib/demoLead/notify';
import { CLIENT_LOCALE_COOKIE, normalizeClientLocale } from '@/lib/clientI18n';
import { TARIFF_LAUNCH } from '@/lib/tariffPricing';
import { marketFromRequestHeaders } from '@/lib/engMarket';
import { heEngRetryMinutes, hitHeEngRateLimit } from '@/lib/hypothesisEngine/engRateLimit';
import { sendHeEngVerificationEmail } from '@/lib/hypothesisEngine/engEmailVerificationMail';

export const dynamic = 'force-dynamic';

/**
 * Open self-signup endpoint. Creates a Supabase auth user with the role
 * already set to 'client' and an inactive client_tariffs row so the user
 * lands in their portal in "demo" mode (status=inactive). They pay later
 * from /client/tariff. No Supabase email confirmation flow — email_confirm=true
 * marks the address as already confirmed (no Supabase email sent). On the ENG
 * host only, the address is confirmed separately by our own link, and sign-ups
 * are rate-limited (see engSignupRateLimited / scheduleEngVerificationEmail).
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

/**
 * ТОЛЬКО ENG-хост (app.outreachos.xyz). Ниже две вещи, которых у RU-регистрации
 * нет и не появляется: RU-ветка этого роута проходит мимо обеих.
 *
 * 1. Счётчик регистраций (lib/hypothesisEngine/engRateLimit): не больше 3 с
 *    одного IP и 3 попыток на один адрес в час. IP — X-Real-IP, который nginx
 *    ENG-хоста ставит из $remote_addr (deploy/nginx/app.outreachos.xyz.conf),
 *    иначе последний адрес X-Forwarded-For (его дописывает nginx); IP нет —
 *    считаем только адрес.
 * 2. Письмо со ссылкой подтверждения почты — после ответа (after()), чтобы
 *    SMTP не держал регистрацию. Пользователь остаётся email_confirm: true:
 *    вход работает сразу, а платные шаги ENG-кабинета ждут подтверждения
 *    (lib/hypothesisEngine/engPaidAccess). Письмо не ушло — кабинет
 *    предлагает отправить ссылку снова.
 */
function signupClientIp(req: NextRequest): string | null {
  const real = req.headers.get('x-real-ip')?.trim();
  if (real) return real;
  const hops = (req.headers.get('x-forwarded-for') ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  return hops.length > 0 ? hops[hops.length - 1] : null;
}

async function engSignupRateLimited(req: NextRequest, email: string): Promise<NextResponse | null> {
  const ip = signupClientIp(req);
  const checks: Array<['signup_ip' | 'signup_email', string]> = [
    ...(ip ? [['signup_ip', ip] as ['signup_ip', string]] : []),
    ['signup_email', email],
  ];
  for (const [bucket, key] of checks) {
    const decision = await hitHeEngRateLimit(supabaseAdmin, bucket, key);
    if (decision.fallbackReason) {
      void logWarn('signup.eng_rate_limit_fallback', `ENG signup rate limit decided in process memory: ${decision.fallbackReason}`, { bucket });
    }
    if (!decision.allowed) {
      void logAudit('signup.eng_rate_limited', `ENG signup refused by ${bucket}`, { bucket, retryAfterSeconds: decision.retryAfterSeconds });
      const minutes = heEngRetryMinutes(decision.retryAfterSeconds);
      return NextResponse.json(
        { error: `Too many sign-up attempts. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.` },
        { status: 429, headers: { 'Retry-After': String(decision.retryAfterSeconds) } },
      );
    }
  }
  return null;
}

function scheduleEngVerificationEmail(userId: string, email: string): void {
  const run = async () => {
    if (!supabaseAdmin) return;
    const outcome = await sendHeEngVerificationEmail(supabaseAdmin, { userId, email });
    if (outcome.kind === 'sent') {
      await logAudit('signup.eng_verification_sent', 'ENG email confirmation link sent', { userId });
    } else if (outcome.kind !== 'already_verified') {
      await logWarn('signup.eng_verification_not_sent', `ENG email confirmation link not sent: ${outcome.kind}`, {
        userId,
        reason: outcome.reason,
      });
    }
  };
  // after() — штатный путь Next для работы после ответа; вне контекста запроса
  // он бросает, тогда просто не ждём промис.
  try {
    after(run);
  } catch {
    void run();
  }
}

/**
 * Тексты ответов для ENG-хоста. Русские остаются в коде ниже как были — RU-ветка
 * отвечает теми же строками. Сырой текст GoTrue на ENG не уходит: роут
 * переводит известные случаи (занятый адрес, слабый пароль, неверный адрес), а
 * остальное — общей фразой.
 *
 * profileFailed: к этому моменту пользователь auth УЖЕ создан (триггер завёл
 * профиль с ролью client и market='eng' из user_metadata), повторная
 * регистрация ответит «уже существует». Поэтому фраза ведёт ко входу, а не к
 * повтору: вход работает, ссылку подтверждения почты кабинет отправит заново
 * («Send a new link»).
 */
const ENG_SIGNUP_TEXT = {
  invalidRequest: 'Invalid request',
  invalidEmail: 'Enter a valid email',
  shortPassword: 'Password must be at least 8 characters',
  noName: 'Enter your name',
  noCompany: 'Enter your company',
  longPhone: 'Phone number is too long',
  longTelegram: 'Telegram username is too long',
  emailTaken: 'An account with this email already exists',
  weakPassword: 'This password is not accepted. Choose a stronger one.',
  createFailed: 'Could not create the account. Try again.',
  profileFailed: 'Your account was created, but its setup did not finish. Sign in to continue; if something does not work, message Support.',
} as const;

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
    const invalidJson = marketFromRequestHeaders(req.headers) === 'eng' ? ENG_SIGNUP_TEXT.invalidRequest : 'Невалидный JSON';
    return NextResponse.json({ error: invalidJson }, { status: 400 });
  }

  const email = (body.email ?? '').trim().toLowerCase();
  const password = body.password ?? '';
  const fullName = (body.full_name ?? '').trim();
  const company = (body.company ?? '').trim();
  const phone = (body.phone ?? '').trim();
  const telegram = (body.telegram ?? '').trim();
  const utm = readSignupUtm(req);
  // Рынок по хосту запроса (ENG-кабинет на app.outreachos.xyz): Origin → Host →
  // Referer, см. lib/engMarket. На RU-хостах market не передаём — колонка
  // profiles.market уйдёт в default 'ru'.
  const market = marketFromRequestHeaders(req.headers);
  const eng = market === 'eng';
  // ENG-кабинет английский: язык профиля — 'en', а не кука RU-переключателя.
  const locale = eng ? 'en' : normalizeClientLocale(req.cookies.get(CLIENT_LOCALE_COOKIE)?.value);

  if (!email || !isEmailLike(email)) {
    return NextResponse.json({ error: eng ? ENG_SIGNUP_TEXT.invalidEmail : 'Введите корректный email' }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: eng ? ENG_SIGNUP_TEXT.shortPassword : 'Пароль должен быть от 8 символов' }, { status: 400 });
  }
  if (!fullName || fullName.length > 200) {
    return NextResponse.json({ error: eng ? ENG_SIGNUP_TEXT.noName : 'Укажите имя' }, { status: 400 });
  }
  if (!company || company.length > 200) {
    return NextResponse.json({ error: eng ? ENG_SIGNUP_TEXT.noCompany : 'Укажите компанию' }, { status: 400 });
  }
  if (phone.length > 50) return NextResponse.json({ error: eng ? ENG_SIGNUP_TEXT.longPhone : 'Слишком длинный телефон' }, { status: 400 });
  if (telegram.length > 100) return NextResponse.json({ error: eng ? ENG_SIGNUP_TEXT.longTelegram : 'Слишком длинный telegram' }, { status: 400 });

  if (eng) {
    const limited = await engSignupRateLimited(req, email);
    if (limited) return limited;
  }

  // Триггер public.handle_new_user (последняя версия — 20260804_0004_*,
  // поверх hardening'а 20260730_0001) автоматически создаёт строку в profiles
  // при INSERT в auth.users: роль захардкожена 'client' (metadata не доверяем),
  // market копируется из raw_user_meta_data->>'market' с fallback 'ru'.
  // Поэтому передаём user_metadata, а сами в profiles не лезем (иначе
  // primary key conflict — что и было в проде 23.06: «Ошибка создания
  // профиля», 500).
  const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: market === 'eng'
      ? { role: 'client', market: 'eng' }
      : { role: 'client' },
  });

  if (createErr || !created?.user) {
    const msg = createErr?.message ?? 'Ошибка создания аккаунта';
    if (/already (registered|exists)|duplicate/i.test(msg)) {
      return NextResponse.json({ error: eng ? ENG_SIGNUP_TEXT.emailTaken : 'Аккаунт с таким email уже существует' }, { status: 409 });
    }
    await logError('signup.create_user_failed', createErr, { email });
    if (eng) {
      // GoTrue: weak_password («Password should be …», «… known to be weak …»)
      // и неверный адрес («Unable to validate email address …»); остальное —
      // общая фраза, текст GoTrue остаётся в логе выше.
      const engError = createErr?.code === 'weak_password' || /password/i.test(msg)
        ? ENG_SIGNUP_TEXT.weakPassword
        : /email/i.test(msg) && /invalid|validate/i.test(msg)
          ? ENG_SIGNUP_TEXT.invalidEmail
          : ENG_SIGNUP_TEXT.createFailed;
      return NextResponse.json({ error: engError }, { status: 400 });
    }
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const userId = created.user.id;

  // Defense-in-depth: если триггер по какой-то причине не сработал или
  // сработал без наших полей — добиваем через update. Идемпотентно: если
  // значения уже стоят — no-op. market пишем только для ENG-хоста (на RU
  // остаётся default 'ru' из колонки).
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
      ...(market === 'eng' ? { market: 'eng' } : {}),
    })
    .eq('id', userId);
  if (profileErr) {
    await logError('signup.profile_update_failed', profileErr, { userId });
    return NextResponse.json({ error: eng ? ENG_SIGNUP_TEXT.profileFailed : 'Ошибка обновления профиля' }, { status: 500 });
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
    return NextResponse.json({ error: eng ? ENG_SIGNUP_TEXT.profileFailed : 'Ошибка инициализации тарифа' }, { status: 500 });
  }

  if (market === 'eng') scheduleEngVerificationEmail(userId, email);

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

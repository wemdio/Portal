import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

/**
 * Open self-signup endpoint. Creates a Supabase auth user with the role
 * already set to 'client' and an inactive client_tariffs row so the user
 * lands in their portal in "demo" mode (status=inactive). They pay later
 * from /client/tariff. No email confirmation flow — email_confirm=true
 * marks the address as already confirmed (no Supabase email sent).
 */
function isEmailLike(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

export async function POST(req: NextRequest) {
  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  let body: { email?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Невалидный JSON' }, { status: 400 });
  }

  const email = (body.email ?? '').trim().toLowerCase();
  const password = body.password ?? '';

  if (!email || !isEmailLike(email)) {
    return NextResponse.json({ error: 'Введите корректный email' }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: 'Пароль должен быть от 8 символов' }, { status: 400 });
  }

  const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
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

  const { error: profileErr } = await supabaseAdmin
    .from('profiles')
    .insert({ id: userId, email, role: 'client', locale: 'ru' });
  if (profileErr) {
    await logError('signup.profile_insert_failed', profileErr, { userId });
    return NextResponse.json({ error: 'Ошибка создания профиля' }, { status: 500 });
  }

  const { error: tariffErr } = await supabaseAdmin
    .from('client_tariffs')
    .insert({
      user_id: userId,
      tariff_type: 'standard',
      is_active: false,
      payment_locked: false,
    });
  if (tariffErr) {
    await logError('signup.tariff_insert_failed', tariffErr, { userId });
    return NextResponse.json({ error: 'Ошибка инициализации тарифа' }, { status: 500 });
  }

  await logAudit('signup.created', `New client signed up: ${email}`, { userId, email });

  return NextResponse.json({ ok: true, user_id: userId }, { status: 201 });
}

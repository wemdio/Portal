import { NextResponse, type NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { sendBrevoEmail } from '@/lib/email/brevoClient';
import { renderPasswordChangedEmail } from '@/lib/email/templates/passwordChanged';
import { logAudit, logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

interface Body {
  currentPassword?: unknown;
  newPassword?: unknown;
}

function formatMoscowTime(d: Date): string {
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(d);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.day}.${map.month}.${map.year}, ${map.hour}:${map.minute} МСК`;
}

export async function POST(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  const { userId } = result.auth;

  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  // Avoid req.nextUrl here — keeps the route directly testable with plain Request.
  const route = (() => {
    try {
      return new URL(req.url).pathname;
    } catch {
      return '/api/client/password';
    }
  })();
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const logMeta = { userId, requestId, route, ip };

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonError('Invalid JSON', 400);
  }

  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

  if (!currentPassword) return jsonError('Не указан текущий пароль', 400);
  if (!newPassword) return jsonError('Не указан новый пароль', 400);
  if (newPassword.length < 8) return jsonError('Новый пароль должен быть не короче 8 символов', 400);
  if (newPassword.length > 72) return jsonError('Новый пароль не должен превышать 72 символа', 400);
  if (newPassword === currentPassword) return jsonError('Новый пароль совпадает с текущим', 400);

  const { data: userData, error: userErr } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (userErr || !userData?.user?.email) {
    await logError('client.password.get_user.failed', userErr ?? 'no email on user', {}, logMeta);
    return jsonError('Не удалось получить email аккаунта', 500);
  }
  const email = userData.user.email;

  // Re-auth: verify current password through a throwaway client so we never
  // accidentally clobber the user's live session.
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);
  const verifier = createAuthedSupabaseClient(token);
  const { error: signInErr } = await verifier.auth.signInWithPassword({
    email,
    password: currentPassword,
  });
  if (signInErr) {
    await logError('client.password.reauth.failed', signInErr, {}, logMeta);
    return jsonError('Неверный текущий пароль', 401);
  }

  const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(userId, {
    password: newPassword,
  });
  if (updateErr) {
    await logError('client.password.update.failed', updateErr, {}, logMeta);
    return jsonError('Не удалось обновить пароль', 500);
  }

  // Fire-and-forget: email failure must not surface as a 500 to the user —
  // their password was already changed successfully.
  const changedAtMsk = formatMoscowTime(new Date());
  const { subject, html, text } = renderPasswordChangedEmail({
    password: newPassword,
    changedAtMsk,
    ip,
  });
  void sendBrevoEmail({ to: email, subject, html, text }).catch((err) =>
    logError('client.password.email.failed', err, { to: email }, logMeta),
  );

  await logAudit('client.password.change.success', 'Client changed own password', {}, logMeta);
  return NextResponse.json({ ok: true });
}

import { NextResponse, type NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { sendTransactionalEmail } from '@/lib/email/smtpClient';
import { renderPasswordChangedEmail } from '@/lib/email/templates/passwordChanged';
import { renderEngPasswordChangedEmail } from '@/lib/email/templates/engPasswordChanged';
import { formatEngEmailUtc } from '@/lib/email/templates/engPasswordReset';
import { HE_ENG_VERIFY_FROM_NAME } from '@/lib/hypothesisEngine/engEmailVerificationMail';
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

/**
 * Ответы ENG-кабинета (страница /client/eng/account). Русские строки ниже не
 * тронуты — RU-кабинет (/client/settings) получает их как раньше.
 *
 * wrongCurrent — 400, а не 401 как в RU: ENG-страница ходит через authFetch,
 * а он на 401 обновляет сессию и ПОВТОРЯЕТ запрос — неверный текущий пароль
 * проверялся бы входом дважды.
 */
const ENG_PASSWORD_TEXT = {
  invalidRequest: 'Invalid request',
  noCurrent: 'Enter your current password.',
  noNew: 'Enter a new password.',
  tooShort: 'The new password must be at least 8 characters.',
  tooLong: 'The new password must be at most 72 characters.',
  sameAsCurrent: 'The new password is the same as the current one.',
  noEmail: 'Could not read your account. Try again in a minute.',
  wrongCurrent: 'The current password is wrong.',
  updateFailed: 'Could not change the password. Try again in a minute.',
} as const;

export async function POST(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  const { userId, market } = result.auth;

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
  // ENG-кабинет: английские ответы и английское письмо. Рынок — тот же, что
  // разрешил общий гейт (requireClientAuth → requestMarket): ENG-хост, а вне
  // него profiles.market = 'eng'. По одному хосту запроса решать нельзя:
  // middleware пускает eng-клиента в /client/eng/** (и на страницу Account) на
  // любом хосте, а сброс пароля по «Forgot password?» выбирается по
  // profiles.market (api/auth/forgot-password: ENG — одноразовая ссылка) —
  // eng-клиент на другом хосте получал бы английские письма и русские ответы. RU-клиент вне ENG-хоста (market не
  // 'eng') получает всё как было; на ENG-хосте RU-клиента и стафф middleware
  // уводит на основной хост.
  const eng = market === 'eng';

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonError(eng ? ENG_PASSWORD_TEXT.invalidRequest : 'Invalid JSON', 400);
  }

  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

  if (!currentPassword) return jsonError(eng ? ENG_PASSWORD_TEXT.noCurrent : 'Не указан текущий пароль', 400);
  if (!newPassword) return jsonError(eng ? ENG_PASSWORD_TEXT.noNew : 'Не указан новый пароль', 400);
  if (newPassword.length < 8) return jsonError(eng ? ENG_PASSWORD_TEXT.tooShort : 'Новый пароль должен быть не короче 8 символов', 400);
  if (newPassword.length > 72) return jsonError(eng ? ENG_PASSWORD_TEXT.tooLong : 'Новый пароль не должен превышать 72 символа', 400);
  if (newPassword === currentPassword) return jsonError(eng ? ENG_PASSWORD_TEXT.sameAsCurrent : 'Новый пароль совпадает с текущим', 400);

  const { data: userData, error: userErr } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (userErr || !userData?.user?.email) {
    await logError('client.password.get_user.failed', userErr ?? 'no email on user', {}, logMeta);
    return jsonError(eng ? ENG_PASSWORD_TEXT.noEmail : 'Не удалось получить email аккаунта', 500);
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
    return eng ? jsonError(ENG_PASSWORD_TEXT.wrongCurrent, 400) : jsonError('Неверный текущий пароль', 401);
  }

  const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(userId, {
    password: newPassword,
  });
  if (updateErr) {
    await logError('client.password.update.failed', updateErr, {}, logMeta);
    return jsonError(eng ? ENG_PASSWORD_TEXT.updateFailed : 'Не удалось обновить пароль', 500);
  }

  // Fire-and-forget: email failure must not surface as a 500 to the user —
  // their password was already changed successfully. ENG: an English notice
  // WITHOUT the new password (engPasswordChanged.ts) from the ENG sender name.
  const { subject, html, text } = eng
    ? renderEngPasswordChangedEmail({ changedAtUtc: formatEngEmailUtc(new Date()) })
    : renderPasswordChangedEmail({
        password: newPassword,
        changedAtMsk: formatMoscowTime(new Date()),
      });
  void sendTransactionalEmail({
    to: email,
    subject,
    html,
    text,
    ...(eng ? { fromName: HE_ENG_VERIFY_FROM_NAME } : {}),
  }).catch((err) =>
    logError('client.password.email.failed', err, { to: email }, logMeta),
  );

  await logAudit('client.password.change.success', 'Client changed own password', {}, logMeta);
  return NextResponse.json({ ok: true });
}

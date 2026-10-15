import 'server-only';

/**
 * Сброс пароля ENG-кабинета (app.outreachos.xyz) — подписанной одноразовой
 * ссылкой, а не новым паролем в письме (аудит 14.10.2026).
 *
 * ДО ЭТОЙ ПРАВКИ ENG-ветка /api/auth/forgot-password повторяла RU: сразу
 * ставила новый пароль и слала его открытым текстом. Любой, кто знает адрес
 * клиента, раз в минуту менял ему пароль (клиент выпадал из кабинета до
 * чтения письма), а пароль лежал в почтовом ящике. RU-сброс не меняется — он
 * в route.ts как был.
 *
 * ПОТОК:
 *  1. POST {email} (форма «Forgot password?»): аккаунт ENG ищется по адресу
 *     ВХОДА — id из auth.users по адресу (he_eng_auth_user_id_by_email,
 *     миграция 20261015_0010, только service_role), затем profiles.market
 *     этого id = 'eng'. profiles.email клиент переписывает сам, и он не
 *     уникален: по нему аккаунт не ищем (до миграции — запасной путь по
 *     profiles с market='eng', каждый кандидат сверяется с auth.users).
 *     Нашёлся — ответ {ok:true} СРАЗУ, остальное после ответа (время ответа
 *     не выдаёт, что адрес — клиент ENG): счётчики частоты (как у
 *     ENG-регистрации: 3 в час с IP и 3 в час на адрес), проверка
 *     блокировки, затем GoTrue admin generateLink('recovery') — одноразовый
 *     токен восстановления хранит GoTrue (письма GoTrue не шлёт) — и наше
 *     английское письмо со ссылкой на адрес входа. Пароль не меняется:
 *     прежний работает, пока клиент не выберет новый.
 *  2. GET ?token= (ссылка из письма): страница на ENG-хосте с формой нового
 *     пароля. Токен здесь НЕ тратится — сканер ссылок почтового сервера,
 *     открывший письмо раньше клиента, ничего не ломает.
 *  3. POST формы (urlencoded): подпись и срок ссылки, пароль (8–72 байта,
 *     повтор совпал) — до траты токена; блокировка; GoTrue verifyOtp
 *     ('recovery', token_hash) на ОТДЕЛЬНОМ клиенте с anon-ключом (как
 *     /demo): общий supabaseAdmin сессию пользователя не получает; токен
 *     одноразовый на стороне GoTrue; затем пароль admin updateUserById,
 *     отзыв всех сессий аккаунта (admin_revoke_user_sessions) и письмо
 *     «Password changed» на адрес входа (как у смены пароля в кабинете).
 *     Ответ GoTrue 4xx — ссылка негодна ('used'); 5xx, 429 и сеть — токен,
 *     скорее всего, цел ('unavailable'). Сбой после траты токена — отдельная
 *     страница: ссылка израсходована, нужна новая.
 *
 * ССЫЛКА: `r2.<userId>.<exp>.<sealed>.<sig>` — sealed = AES-256-GCM
 * (iv ‖ шифртекст ‖ тег) от hashed_token из generateLink, exp — наш срок
 * (ENG_RESET_LINK_TTL_MS), sig — HMAC-SHA256. Оба ключа выведены из
 * engServerKey('email-verify') со своими метками (подпись ссылки
 * подтверждения и ссылки сброса не взаимозаменяемы). hashed_token в ссылке
 * открытым текстом не лежит: /auth/v1/verify на ENG-хосте открыт с публичным
 * anon-ключом, и ссылка из журнала nginx, истории браузера или пересланного
 * письма иначе давала бы вход мимо нашей формы (мимо проверки блокировки,
 * часового срока и отзыва сессий). Подделка и мусор отсекаются без GoTrue и
 * БД.
 *
 * Страница — ответ этого же роута, а не страница приложения: публичные пути
 * страниц middleware перечисляет поимённо, а /api/auth/forgot-password уже в
 * его списке публичных API (GET и POST).
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { sendTransactionalEmail } from '@/lib/email/smtpClient';
import { renderEngPasswordChangedEmail } from '@/lib/email/templates/engPasswordChanged';
import { formatEngEmailUtc } from '@/lib/email/templates/engPasswordReset';
import type { RenderedEmail } from '@/lib/email/templates/engEmailVerification';
import { heEngAppOrigin, HE_ENG_VERIFY_FROM_NAME } from '@/lib/hypothesisEngine/engEmailVerificationMail';
import { readHeEngAccountBlock } from '@/lib/hypothesisEngine/engAccountBlockMarker';
import { readHeEngAuthEmail } from '@/lib/hypothesisEngine/engEmailVerification';
import { deriveHeEngKey } from '@/lib/hypothesisEngine/engServerKey';
import { heEngRetryMinutes, hitHeEngRateLimit } from '@/lib/hypothesisEngine/engRateLimit';
import { logAudit, logError, logWarn } from '@/lib/loggerServer';

/** Срок ссылки сброса: 1 час от отправки (GoTrue держит свой токен не меньше — 24 ч по умолчанию). */
export const ENG_RESET_LINK_TTL_MS = 60 * 60 * 1000;

const RESET_PATH = '/api/auth/forgot-password';
/** r2 — hashed_token в ссылке зашифрован (r1 нёс его открытым текстом; r1 на прод не выезжал). */
const TOKEN_VERSION = 'r2';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_RE = /^[A-Za-z0-9_-]+$/;
const PASSWORD_MIN = 8;
/** bcrypt GoTrue учитывает 72 байта; длиннее — GoTrue откажет уже после траты токена. */
const PASSWORD_MAX_BYTES = 72;
/** Запасной поиск по profiles (функции поиска по адресу входа ещё нет): столько кандидатов с market='eng'. */
const MAX_CANDIDATES = 10;
/** Поиск id аккаунта по адресу входа (auth.users), миграция 20261015_0010. */
const AUTH_USER_BY_EMAIL_RPC = 'he_eng_auth_user_id_by_email';
const SEAL_IV_BYTES = 12;
const SEAL_TAG_BYTES = 16;

/** Поля строки журнала (loggerServer meta) — как у logMeta RU-ветки роута. */
type LogMeta = { email?: string; requestId?: string; ip?: string; route?: string; userId?: string };

/* ─────────────── Ссылка ─────────────── */

function resetKeys(env: NodeJS.ProcessEnv): { sign: Buffer; seal: Buffer } | null {
  const base = deriveHeEngKey('email-verify', env);
  if (!base) return null;
  return {
    sign: createHmac('sha256', base).update('he-eng-password-reset-v1').digest(),
    seal: createHmac('sha256', base).update('he-eng-password-reset-seal-v1').digest(),
  };
}

function sign(key: Buffer, body: string): string {
  return createHmac('sha256', key).update(body).digest('base64url');
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** hashed_token → base64url(iv ‖ шифртекст ‖ тег); aad — начало ссылки (версия, пользователь, срок). */
function sealHashedToken(key: Buffer, hashedToken: string, aad: string): string {
  const iv = randomBytes(SEAL_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(hashedToken, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url');
}

/** null — не расшифровалось (чужой ключ, порча, подмена начала ссылки). */
function openHashedToken(key: Buffer, sealed: string, aad: string): string | null {
  try {
    const raw = Buffer.from(sealed, 'base64url');
    if (raw.length <= SEAL_IV_BYTES + SEAL_TAG_BYTES) return null;
    const iv = raw.subarray(0, SEAL_IV_BYTES);
    const tag = raw.subarray(raw.length - SEAL_TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    const text = Buffer.concat([decipher.update(raw.subarray(SEAL_IV_BYTES, raw.length - SEAL_TAG_BYTES)), decipher.final()]).toString('utf8');
    return SAFE_RE.test(text) ? text : null;
  } catch {
    return null;
  }
}

/** null — ключа нет (SUPABASE_SERVICE_ROLE_KEY не задан) или токен GoTrue неожиданной формы. */
export function createEngResetToken(
  userId: string,
  hashedToken: string,
  nowMs: number,
  env: NodeJS.ProcessEnv = process.env,
): { token: string; expiresAt: Date } | null {
  const keys = resetKeys(env);
  if (!keys || !UUID_RE.test(userId) || !SAFE_RE.test(hashedToken) || hashedToken.length > 200) return null;
  const exp = Math.floor((nowMs + ENG_RESET_LINK_TTL_MS) / 1000);
  const head = `${TOKEN_VERSION}.${userId.toLowerCase()}.${exp}`;
  const body = `${head}.${sealHashedToken(keys.seal, hashedToken, head)}`;
  return { token: `${body}.${sign(keys.sign, body)}`, expiresAt: new Date(exp * 1000) };
}

export type EngResetTokenParse =
  | { ok: true; userId: string; hashedToken: string; expired: boolean }
  | { ok: false; reason: 'invalid' | 'no_key' };

export function parseEngResetToken(
  raw: unknown,
  nowMs: number,
  env: NodeJS.ProcessEnv = process.env,
): EngResetTokenParse {
  const keys = resetKeys(env);
  if (!keys) return { ok: false, reason: 'no_key' };
  if (typeof raw !== 'string' || raw.length > 500) return { ok: false, reason: 'invalid' };
  const parts = raw.trim().split('.');
  if (parts.length !== 5) return { ok: false, reason: 'invalid' };
  const [version, userId, expRaw, sealed, sig] = parts;
  if (version !== TOKEN_VERSION || !UUID_RE.test(userId) || !/^\d{1,12}$/.test(expRaw)) {
    return { ok: false, reason: 'invalid' };
  }
  if (!SAFE_RE.test(sealed) || !SAFE_RE.test(sig)) return { ok: false, reason: 'invalid' };
  const head = `${version}.${userId}.${expRaw}`;
  if (!sameText(sign(keys.sign, `${head}.${sealed}`), sig)) return { ok: false, reason: 'invalid' };
  const hashedToken = openHashedToken(keys.seal, sealed, head);
  if (!hashedToken) return { ok: false, reason: 'invalid' };
  return { ok: true, userId: userId.toLowerCase(), hashedToken, expired: Number(expRaw) * 1000 <= nowMs };
}

/* ─────────────── Письмо ─────────────── */

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Письмо со ссылкой сброса. Что обещает и почему это правда: «пароль не
 * меняется, пока вы не выберете новый» — роут его не трогает до формы;
 * «ссылка работает один раз в течение часа» — одноразовость держит GoTrue
 * (verifyOtp), час — exp подписи; «ничего не делайте» — без перехода по
 * ссылке ничего не меняется.
 */
export function renderEngResetLinkEmail(args: { link: string; requestedAtUtc: string }): RenderedEmail {
  const subject = 'Reset your outreachOS password';
  const html = `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;padding:32px;">
        <tr><td>
          <h1 style="font-size:20px;margin:0 0 16px;color:#1a1a1a;">Reset your password</h1>
          <p style="font-size:15px;line-height:1.5;margin:0 0 12px;">
            Someone asked to reset the password of your outreachOS account on <strong>${esc(args.requestedAtUtc)}</strong>. To choose a new password, open the link below.
          </p>
          <p style="margin:24px 0;">
            <a href="${esc(args.link)}" style="display:inline-block;background:#1a1a1a;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 20px;border-radius:6px;">Choose a new password</a>
          </p>
          <p style="font-size:12px;line-height:1.5;margin:0 0 12px;color:#444;word-break:break-all;">${esc(args.link)}</p>
          <p style="font-size:15px;line-height:1.5;margin:0 0 12px;">
            The link works once, for 1 hour. Your current password keeps working until you choose a new one.
          </p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0;" />
          <p style="font-size:13px;line-height:1.5;margin:0;color:#444;">
            If you did not ask for this, ignore this email: nothing changes unless the link is opened and a new password is saved.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  const text = [
    'Reset your password',
    '',
    `Someone asked to reset the password of your outreachOS account on ${args.requestedAtUtc}. To choose a new password, open this link:`,
    args.link,
    '',
    'The link works once, for 1 hour. Your current password keeps working until you choose a new one.',
    '',
    'If you did not ask for this, ignore this email: nothing changes unless the link is opened and a new password is saved.',
  ].join('\n');
  return { subject, html, text };
}

/* ─────────────── Страница ─────────────── */

type PageState =
  | { kind: 'form'; token: string; error?: string }
  | { kind: 'done'; signedOut: boolean }
  | { kind: 'invalid' }
  | { kind: 'expired' }
  | { kind: 'used' }
  | { kind: 'blocked' }
  | { kind: 'rejected' }
  | { kind: 'unavailable' }
  | { kind: 'unavailable_used' };

const ASK_AGAIN = 'Ask for a new one: on the sign-in page, press “Forgot password?”.';

function pageBody(state: PageState): { title: string; html: string; status: number } {
  switch (state.kind) {
    case 'form':
      return {
        title: 'Choose a new password',
        status: state.error ? 400 : 200,
        html:
          (state.error ? `<p class="error" role="alert">${esc(state.error)}</p>` : '') +
          `<form method="post" action="${RESET_PATH}">
  <input type="hidden" name="token" value="${esc(state.token)}">
  <label for="password">New password</label>
  <input id="password" name="password" type="password" autocomplete="new-password" minlength="${PASSWORD_MIN}" required>
  <label for="confirm">Repeat the new password</label>
  <input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="${PASSWORD_MIN}" required>
  <p class="hint">At least ${PASSWORD_MIN} characters.</p>
  <button type="submit">Save the new password</button>
</form>`,
      };
    case 'done':
      return {
        title: 'Your password was changed',
        status: 200,
        html:
          '<p>Sign in with your new password.' +
          (state.signedOut ? ' Every device that was signed in to this account has been signed out.' : '') +
          '</p><p><a class="button" href="/login">Go to sign-in</a></p>',
      };
    case 'invalid':
      return {
        title: 'This link does not work',
        status: 400,
        html: `<p>The link is incomplete or changed. ${ASK_AGAIN}</p><p><a href="/login">Go to sign-in</a></p>`,
      };
    case 'expired':
      return {
        title: 'This link has expired',
        status: 410,
        html: `<p>A reset link works for 1 hour. ${ASK_AGAIN}</p><p><a href="/login">Go to sign-in</a></p>`,
      };
    case 'used':
      return {
        title: 'This link can no longer be used',
        status: 410,
        html:
          `<p>It was already used, or a newer link was sent after it. Your password did not change. ${ASK_AGAIN}</p>` +
          '<p><a href="/login">Go to sign-in</a></p>',
      };
    case 'blocked':
      return { title: 'This account is blocked', status: 403, html: '<p>The password was not changed.</p>' };
    case 'rejected':
      return {
        title: 'This password was not accepted',
        status: 400,
        html:
          `<p>Your password did not change, and this link has been used up. ${ASK_AGAIN} Then choose a different password.</p>` +
          '<p><a href="/login">Go to sign-in</a></p>',
      };
    case 'unavailable':
      // Только пока токен не потрачен: та же ссылка ещё сработает.
      return {
        title: 'We could not change the password',
        status: 503,
        html: '<p>Your password did not change. Try again in a few minutes.</p>',
      };
    case 'unavailable_used':
      // GoTrue уже принял (потратил) токен, а смена пароля не прошла.
      return {
        title: 'We could not change the password',
        status: 503,
        html:
          `<p>Your password did not change, and this link has been used up. ${ASK_AGAIN}</p>` +
          '<p><a href="/login">Go to sign-in</a></p>',
      };
  }
}

function pageResponse(state: PageState): NextResponse {
  const { title, html, status } = pageBody(state);
  const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · outreachOS</title>
<style>
  body{margin:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a}
  main{max-width:420px;margin:48px auto;background:#fff;border-radius:8px;padding:32px;box-sizing:border-box}
  @media (max-width:480px){main{margin:16px;padding:24px}}
  h1{font-size:20px;margin:0 0 16px}
  p{font-size:15px;line-height:1.5;margin:0 0 12px}
  label{display:block;font-size:14px;font-weight:600;margin:16px 0 6px}
  input[type=password]{width:100%;box-sizing:border-box;font-size:15px;padding:10px 12px;border:1px solid #ccc;border-radius:6px}
  button,.button{display:inline-block;margin-top:16px;background:#1a1a1a;color:#fff;border:0;border-radius:6px;padding:12px 20px;font-size:15px;font-weight:600;text-decoration:none;cursor:pointer}
  .hint{font-size:13px;color:#555;margin-top:8px}
  .error{color:#a00}
  a{color:#1a1a1a}
</style>
</head>
<body><main><h1>${esc(title)}</h1>${html}</main></body>
</html>`;
  return new NextResponse(doc, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // Ссылка несёт токен в query: ни Referer, ни чужой фрейм.
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

/* ─────────────── Общее ─────────────── */

/** IP так же, как у ENG-регистрации (api/signup): X-Real-IP от nginx, иначе последний X-Forwarded-For. */
export function engResetClientIp(req: NextRequest): string | null {
  const real = req.headers.get('x-real-ip')?.trim();
  if (real) return real;
  const hops = (req.headers.get('x-forwarded-for') ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  return hops.length > 0 ? hops[hops.length - 1] : null;
}

/**
 * Заблокированный ENG-аккаунт (S3b: блокировка останавливает всё): отметка
 * блокировки (he_eng_account_blocks) или ещё не истёкший бан Supabase, в том
 * числе поставленный мимо карточки. 'unread' — что-то не прочиталось: ни
 * письма, ни смены пароля. Таблицы отметок нет (миграция 20261013_0001 не
 * применена) — решает один бан.
 */
export async function engResetRefusal(
  db: SupabaseClient,
  userId: string,
): Promise<{ kind: 'blocked'; source: 'marker' | 'ban' } | { kind: 'unread'; detail: string } | null> {
  const marker = await readHeEngAccountBlock(db, userId);
  if (marker.state === 'blocked') return { kind: 'blocked', source: 'marker' };
  if (marker.state === 'error') return { kind: 'unread', detail: marker.detail };
  try {
    const { data, error } = await db.auth.admin.getUserById(userId);
    if (error || !data?.user) return { kind: 'unread', detail: `auth user read: ${error?.message ?? 'no user'}` };
    const bannedUntil = typeof data.user.banned_until === 'string' ? data.user.banned_until.trim() : '';
    if (!bannedUntil) return null;
    // Непарсящийся срок бана — бан (fail-closed), как у автозапуска.
    const until = Date.parse(bannedUntil);
    return !Number.isFinite(until) || until > Date.now() ? { kind: 'blocked', source: 'ban' } : null;
  } catch (e) {
    return { kind: 'unread', detail: `auth user read threw: ${e instanceof Error ? e.message : 'unknown'}` };
  }
}

/* ─────────────── 1. Запрос ссылки ─────────────── */

export type EngResetAccount =
  | { kind: 'eng'; userId: string; email: string }
  | { kind: 'not_eng' }
  | { kind: 'unread'; detail: string };

/**
 * ENG-аккаунт, чей адрес ВХОДА — введённый. id — из auth.users по адресу
 * (he_eng_auth_user_id_by_email, только service_role), затем market профиля
 * этого id. profiles.email клиент переписывает сам и он не уникален: чужие
 * строки с тем же адресом на поиск не влияют. Нет совпадения — 'not_eng':
 * дальше идёт прежний RU-путь.
 *
 * Функции ещё нет (миграция 20261015_0010 не применена) — запасной путь:
 * кандидаты из profiles с этим email и market='eng' (фильтр в запросе, так
 * что строки RU-аккаунтов места не занимают), каждый сверяется с auth.users.
 */
export async function resolveEngResetAccount(db: SupabaseClient, emailRaw: string): Promise<EngResetAccount> {
  const { data: rpcId, error: rpcErr } = await db.rpc(AUTH_USER_BY_EMAIL_RPC, { p_email: emailRaw });
  if (!rpcErr) {
    const userId = typeof rpcId === 'string' && UUID_RE.test(rpcId) ? rpcId.toLowerCase() : null;
    if (!userId) return { kind: 'not_eng' };
    const { data: profile, error: profileErr } = await db.from('profiles').select('market').eq('id', userId).maybeSingle();
    if (profileErr) {
      // 42703 — колонки market нет: ENG-аккаунтов быть не может.
      if (profileErr.code === '42703') return { kind: 'not_eng' };
      return { kind: 'unread', detail: `profiles read: ${profileErr.code ?? 'error'}` };
    }
    return (profile as { market?: unknown } | null)?.market === 'eng'
      ? { kind: 'eng', userId, email: emailRaw }
      : { kind: 'not_eng' };
  }
  if (rpcErr.code !== '42883' && rpcErr.code !== 'PGRST202') {
    return { kind: 'unread', detail: `${AUTH_USER_BY_EMAIL_RPC} rpc: ${rpcErr.code ?? 'error'}` };
  }

  const { data, error } = await db
    .from('profiles')
    .select('id')
    .eq('email', emailRaw)
    .eq('market', 'eng')
    .limit(MAX_CANDIDATES);
  if (error) {
    if (error.code === '42703') return { kind: 'not_eng' };
    return { kind: 'unread', detail: `profiles read: ${error.code ?? 'error'}` };
  }
  const candidates = ((data ?? []) as Array<{ id?: unknown }>)
    .filter((r) => typeof r.id === 'string')
    .map((r) => r.id as string);
  let unread: string | null = null;
  for (const id of candidates) {
    const auth = await readHeEngAuthEmail(db, id);
    if (auth.kind === 'ok' && auth.email === emailRaw) return { kind: 'eng', userId: id, email: auth.email };
    if (auth.kind === 'error') unread = auth.message;
  }
  return unread ? { kind: 'unread', detail: unread } : { kind: 'not_eng' };
}

/**
 * Счётчики частоты сброса — тем же счётчиком и с теми же правилами, что у
 * ENG-регистрации (engRateLimit: 3 в час с IP, 3 в час на адрес), под
 * отдельными ключами (префикс 'pw-reset:'): регистрация и сброс друг у друга
 * мест не отнимают. Отказ молчит: ответ {ok:true}, как у любого адреса.
 */
async function engResetRateLimited(ip: string | null, email: string, logMeta: LogMeta): Promise<boolean> {
  const checks: Array<['signup_ip' | 'signup_email', string]> = [
    ...(ip ? [['signup_ip', `pw-reset:${ip}`] as ['signup_ip', string]] : []),
    ['signup_email', `pw-reset:${email}`],
  ];
  for (const [bucket, key] of checks) {
    const decision = await hitHeEngRateLimit(supabaseAdmin, bucket, key);
    if (decision.fallbackReason) {
      void logWarn('auth.forgot.eng_rate_limit_fallback', `ENG reset rate limit decided in process memory: ${decision.fallbackReason}`, { bucket });
    }
    if (!decision.allowed) {
      await logAudit(
        'auth.forgot.eng_rate_limited',
        `ENG reset link refused by ${bucket === 'signup_ip' ? 'ip' : 'email'} limit`,
        { retryMinutes: heEngRetryMinutes(decision.retryAfterSeconds) },
        logMeta,
      );
      return true;
    }
  }
  return false;
}

/**
 * ENG-ветка запроса сброса: ссылка на адрес входа. НЕ БРОСАЕТ. Роут
 * запускает её ПОСЛЕ ответа {ok:true} (route.ts): время ответа одинаково для
 * адреса клиента ENG и для неизвестного адреса. ip — engResetClientIp,
 * снятый с запроса до ответа.
 */
export async function sendEngResetLink(
  ip: string | null,
  account: { userId: string; email: string },
  logMeta: LogMeta,
): Promise<void> {
  if (!supabaseAdmin) return;
  try {
    if (await engResetRateLimited(ip, account.email, logMeta)) return;

    const refusal = await engResetRefusal(supabaseAdmin, account.userId);
    if (refusal?.kind === 'blocked') {
      await logAudit('auth.forgot.eng_blocked', 'Forgot-password refused: ENG account is blocked', { source: refusal.source }, logMeta);
      return;
    }
    if (refusal?.kind === 'unread') {
      await logError('auth.forgot.eng_block_read.failed', null, { detail: refusal.detail.slice(0, 300) }, logMeta);
      return;
    }

    const gen = await supabaseAdmin.auth.admin.generateLink({ type: 'recovery', email: account.email });
    const hashedToken = gen.data?.properties?.hashed_token ?? '';
    if (gen.error || !hashedToken) {
      await logError('auth.forgot.eng_link.generate_failed', gen.error ?? null, { hasToken: Boolean(hashedToken) }, logMeta);
      return;
    }
    if (gen.data?.user?.id && gen.data.user.id !== account.userId) {
      // GoTrue нашёл по адресу другого пользователя — ссылку не шлём.
      await logError('auth.forgot.eng_link.user_mismatch', null, {}, logMeta);
      return;
    }
    const now = Date.now();
    const token = createEngResetToken(account.userId, hashedToken, now);
    if (!token) {
      await logError('auth.forgot.eng_link.sign_failed', null, {}, logMeta);
      return;
    }
    const link = `${heEngAppOrigin()}${RESET_PATH}?token=${encodeURIComponent(token.token)}`;
    const { subject, html, text } = renderEngResetLinkEmail({ link, requestedAtUtc: formatEngEmailUtc(new Date(now)) });
    try {
      await sendTransactionalEmail({ to: account.email, subject, html, text, fromName: HE_ENG_VERIFY_FROM_NAME });
      await logAudit('auth.forgot.eng_link_sent', 'ENG password reset link sent', { to: account.email }, logMeta);
    } catch (err) {
      // Пароль не менялся — клиенту ничего не сломано; новый запрос пришлёт новую ссылку.
      await logError('auth.forgot.eng_link.email_failed', err, { to: account.email }, logMeta);
    }
  } catch (err) {
    await logError('auth.forgot.eng_link.threw', err, {}, logMeta);
  }
}

/* ─────────────── 2. Страница по ссылке ─────────────── */

export function engResetPageResponse(req: NextRequest): NextResponse {
  const raw = req.nextUrl.searchParams.get('token');
  const parsed = parseEngResetToken(raw, Date.now());
  if (!parsed.ok) return pageResponse(parsed.reason === 'no_key' ? { kind: 'unavailable' } : { kind: 'invalid' });
  if (parsed.expired) return pageResponse({ kind: 'expired' });
  return pageResponse({ kind: 'form', token: String(raw).trim() });
}

/* ─────────────── 3. Новый пароль ─────────────── */

/** Форма страницы шлёт urlencoded; RU-запрос сброса и форма «Forgot password?» — JSON. */
export function isEngResetFormRequest(req: NextRequest): boolean {
  const type = (req.headers.get('content-type') ?? '').toLowerCase();
  return type.startsWith('application/x-www-form-urlencoded') || type.startsWith('multipart/form-data');
}

function passwordProblem(password: string, confirm: string): string | null {
  if (password.length < PASSWORD_MIN) return `The password must be at least ${PASSWORD_MIN} characters.`;
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) return 'The password is too long. Use at most 72 characters.';
  if (password !== confirm) return 'The two passwords do not match.';
  return null;
}

export async function engResetSubmitResponse(req: NextRequest): Promise<NextResponse> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return pageResponse({ kind: 'invalid' });
  }
  const rawToken = String(form.get('token') ?? '').trim();
  const password = String(form.get('password') ?? '');
  const confirm = String(form.get('confirm') ?? '');
  const parsed = parseEngResetToken(rawToken, Date.now());
  if (!parsed.ok) return pageResponse(parsed.reason === 'no_key' ? { kind: 'unavailable' } : { kind: 'invalid' });
  if (parsed.expired) return pageResponse({ kind: 'expired' });

  // Пароль — ДО траты токена: ошибка в форме не съедает ссылку.
  const problem = passwordProblem(password, confirm);
  if (problem) return pageResponse({ kind: 'form', token: rawToken, error: problem });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const logMeta: LogMeta = { route: RESET_PATH, userId: parsed.userId };
  if (!supabaseAdmin || !supabaseUrl || !anonKey) {
    await logError('auth.forgot.eng_set.misconfigured', null, {}, logMeta);
    return pageResponse({ kind: 'unavailable' });
  }

  const refusal = await engResetRefusal(supabaseAdmin, parsed.userId);
  if (refusal?.kind === 'blocked') {
    await logAudit('auth.forgot.eng_set_blocked', 'ENG password reset refused: account is blocked', { source: refusal.source }, logMeta);
    return pageResponse({ kind: 'blocked' });
  }
  if (refusal?.kind === 'unread') {
    await logError('auth.forgot.eng_set.block_read_failed', null, { detail: refusal.detail.slice(0, 300) }, logMeta);
    return pageResponse({ kind: 'unavailable' });
  }

  // Отдельный клиент на запрос: сессия восстановления не должна попасть в
  // общий supabaseAdmin (его запросы ушли бы с JWT пользователя).
  const recovery = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  let verified: Awaited<ReturnType<typeof recovery.auth.verifyOtp>>;
  try {
    verified = await recovery.auth.verifyOtp({ type: 'recovery', token_hash: parsed.hashedToken });
  } catch (err) {
    await logError('auth.forgot.eng_set.verify_threw', err, {}, logMeta);
    return pageResponse({ kind: 'unavailable' });
  }
  const verifiedUserId = verified.data?.user?.id ?? null;
  if (verified.error || !verifiedUserId) {
    const detail = String(verified.error?.message ?? 'no user').slice(0, 200);
    if (verified.error && verifyErrorLeavesTokenUnspent(verified.error)) {
      // Сбой GoTrue или сети, лимит запросов — токен, скорее всего, цел:
      // «ссылка уже использована» было бы неправдой.
      await logError('auth.forgot.eng_set.verify_unavailable', verified.error, { detail }, logMeta);
      return pageResponse({ kind: 'unavailable' });
    }
    await logAudit('auth.forgot.eng_set_link_rejected', 'ENG password reset link rejected by GoTrue', { detail }, logMeta);
    return pageResponse({ kind: 'used' });
  }
  if (verifiedUserId !== parsed.userId) {
    await logError('auth.forgot.eng_set.user_mismatch', null, {}, logMeta);
    return pageResponse({ kind: 'used' });
  }

  // Дальше токен потрачен: при сбое та же ссылка уже не сработает.
  const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(parsed.userId, { password });
  if (updateErr) {
    const weak = (updateErr as { code?: unknown }).code === 'weak_password' || /password/i.test(updateErr.message ?? '');
    await logError('auth.forgot.eng_set.update_failed', updateErr, { weak }, logMeta);
    return pageResponse(weak ? { kind: 'rejected' } : { kind: 'unavailable_used' });
  }

  // Новый пароль — все прежние сессии (и эта, восстановления) закрываются.
  const { error: revokeErr } = await supabaseAdmin.rpc('admin_revoke_user_sessions', { target_user_id: parsed.userId });
  if (revokeErr) {
    await logWarn('auth.forgot.eng_set.sessions_not_revoked', String(revokeErr.message ?? 'error').slice(0, 200), {}, logMeta);
  }
  await logAudit('auth.forgot.eng_set_done', 'ENG password changed through a reset link', { sessionsRevoked: !revokeErr }, logMeta);

  // Уведомление владельцу, как у смены пароля в кабинете (api/client/password):
  // без пароля, на адрес входа (пользователь из ответа GoTrue — auth.users).
  // Письмо не задерживает страницу и не ломает её при сбое.
  const notifyTo = normalizeNotifyAddress(verified.data?.user?.email);
  if (notifyTo) {
    const { subject, html, text } = renderEngPasswordChangedEmail({ changedAtUtc: formatEngEmailUtc(new Date()) });
    void sendTransactionalEmail({ to: notifyTo, subject, html, text, fromName: HE_ENG_VERIFY_FROM_NAME }).catch((err) =>
      logError('auth.forgot.eng_set.notice_failed', err, {}, logMeta),
    );
  } else {
    void logWarn('auth.forgot.eng_set.notice_skipped', 'No sign-in address on the GoTrue user', {}, logMeta);
  }
  return pageResponse({ kind: 'done', signedOut: !revokeErr });
}

/**
 * Ошибка verifyOtp, после которой токен, скорее всего, не потрачен: сеть
 * (AuthRetryableFetchError, статус 0), 5xx GoTrue/Kong и 429 (лимит
 * запросов). 4xx — otp_expired / неверный токен: ссылка негодна.
 */
export function verifyErrorLeavesTokenUnspent(error: { name?: unknown; status?: unknown }): boolean {
  if (error.name === 'AuthRetryableFetchError') return true;
  const status = typeof error.status === 'number' ? error.status : null;
  if (status === null) return true;
  return status === 0 || status === 429 || status >= 500;
}

function normalizeNotifyAddress(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  return email && email.includes('@') ? email : null;
}

import 'server-only';

/**
 * Сброс пароля RU-аккаунта в два шага (24.10.2026).
 *
 * Раньше POST /api/auth/forgot-password менял пароль сразу и присылал новый на
 * почту. Зная адрес сотрудника или админа, кто угодно мог раз в минуту
 * сбрасывать ему пароль, и человек не мог войти со своим. Теперь:
 *   1. запрос сброса шлёт письмо со ссылкой — пароль не меняется;
 *   2. ссылка открывает страницу с кнопкой (а не меняет пароль сама: почтовые
 *      сканеры заранее открывают ссылки GET-запросом);
 *   3. кнопка (POST по той же ссылке) меняет пароль и присылает новый письмом,
 *      как раньше.
 *
 * Ссылка подписана HMAC и живёт час. В подпись входит updated_at пользователя
 * в GoTrue: смена пароля его меняет, и использованная ссылка гаснет. Сам
 * отпечаток в ссылку не пишется. ENG-аккаунты сюда не попадают — у них свой
 * сброс с выбором пароля (_engReset.ts).
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { sendTransactionalEmail } from '@/lib/email/smtpClient';
import { renderPasswordResetEmail } from '@/lib/email/templates/passwordReset';
import { generateStrongPassword } from '@/lib/passwordGenerator';
import { deriveHeEngKey } from '@/lib/hypothesisEngine/engServerKey';
import { logAudit, logError } from '@/lib/loggerServer';

/** Параметр ссылки: GET — страница с кнопкой, POST — сам сброс. */
export const RU_RESET_PARAM = 'rt';
export const RU_RESET_TTL_MS = 60 * 60 * 1000;

const VERSION = 'ru1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIG_RE = /^[A-Za-z0-9_-]+$/;
const RESET_PATH = '/api/auth/forgot-password';

function resetKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const base = deriveHeEngKey('email-verify', env);
  return base ? createHmac('sha256', base).update('ru-password-reset-v1').digest() : null;
}

function signature(key: Buffer, head: string, stamp: string): string {
  return createHmac('sha256', key).update(`${head}.${stamp}`).digest('base64url');
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Отпечаток аккаунта: меняется со сменой пароля. null — пользователь не найден. */
async function accountStamp(userId: string): Promise<{ stamp: string; email: string | null } | null> {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (error || !data?.user) return null;
  return { stamp: String(data.user.updated_at ?? ''), email: data.user.email ?? null };
}

/** Адрес, на котором портал открыт людям: ссылка из письма ведёт туда. */
export function ruResetOrigin(req: NextRequest): string {
  return (process.env.PORTAL_PUBLIC_URL || process.env.NEXT_PUBLIC_SITE_URL || req.nextUrl.origin).replace(/\/+$/, '');
}

/** Ссылка подтверждения сброса; null — нечем подписать или пользователя нет. */
export async function createRuResetLink(origin: string, userId: string, nowMs: number): Promise<string | null> {
  const key = resetKey();
  if (!key || !UUID_RE.test(userId)) return null;
  const account = await accountStamp(userId);
  if (!account) return null;
  const exp = Math.floor((nowMs + RU_RESET_TTL_MS) / 1000);
  const head = `${VERSION}.${userId.toLowerCase()}.${exp}`;
  const token = `${head}.${signature(key, head, account.stamp)}`;
  return `${origin}${RESET_PATH}?${RU_RESET_PARAM}=${encodeURIComponent(token)}`;
}

type TokenCheck =
  | { ok: true; userId: string; token: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'unavailable' };

async function checkToken(raw: string | null, nowMs: number): Promise<TokenCheck> {
  const key = resetKey();
  if (!key) return { ok: false, reason: 'unavailable' };
  const token = (raw ?? '').trim();
  if (!token || token.length > 300) return { ok: false, reason: 'invalid' };
  const parts = token.split('.');
  if (parts.length !== 4) return { ok: false, reason: 'invalid' };
  const [version, userId, expRaw, sig] = parts;
  if (version !== VERSION || !UUID_RE.test(userId) || !/^\d{1,12}$/.test(expRaw) || !SIG_RE.test(sig)) {
    return { ok: false, reason: 'invalid' };
  }
  const account = await accountStamp(userId);
  // Подпись не сходится — подделка или ссылка уже использована (пароль сменился).
  if (!account || !sameText(signature(key, `${version}.${userId}.${expRaw}`, account.stamp), sig)) {
    return { ok: false, reason: 'invalid' };
  }
  if (Number(expRaw) * 1000 <= nowMs) return { ok: false, reason: 'expired' };
  return { ok: true, userId: userId.toLowerCase(), token };
}

/* ─────────────── Страница ─────────────── */

type PageState =
  | { kind: 'form'; token: string }
  | { kind: 'done' }
  | { kind: 'invalid' }
  | { kind: 'expired' }
  | { kind: 'unavailable' }
  | { kind: 'failed' };

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const ASK_AGAIN = 'Запросите сброс ещё раз: на странице входа нажмите «Забыли пароль?».';

function pageBody(state: PageState): { title: string; html: string; status: number } {
  switch (state.kind) {
    case 'form':
      return {
        title: 'Сброс пароля',
        status: 200,
        html: `<p>Нажмите кнопку — пароль сменится, а новый придёт на вашу почту отдельным письмом.</p>
<form method="post" action="${RESET_PATH}?${RU_RESET_PARAM}=${encodeURIComponent(state.token)}">
  <button type="submit">Сбросить пароль</button>
</form>
<p class="muted">Если вы не запрашивали сброс — просто закройте страницу, пароль не изменится.</p>`,
      };
    case 'done':
      return {
        title: 'Пароль сброшен',
        status: 200,
        html: '<p>Новый пароль отправлен на вашу почту. Войдите с ним и смените его на свой через «Настройки».</p>',
      };
    case 'expired':
      return { title: 'Ссылка устарела', status: 410, html: `<p>Ссылка действовала 1 час. ${ASK_AGAIN}</p>` };
    case 'unavailable':
      return { title: 'Сброс недоступен', status: 503, html: '<p>Сброс пароля сейчас недоступен. Напишите администратору.</p>' };
    case 'failed':
      return {
        title: 'Не получилось',
        status: 500,
        html: `<p>Не удалось сбросить пароль или отправить письмо. ${ASK_AGAIN}</p>`,
      };
    default:
      return { title: 'Ссылка недействительна', status: 400, html: `<p>Ссылка недействительна или уже использована. ${ASK_AGAIN}</p>` };
  }
}

function pageResponse(state: PageState): NextResponse {
  const { title, html, status } = pageBody(state);
  const doc = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${esc(title)}</title>
<style>
  body { margin: 0; background: #f5f5f5; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #1a1a1a; }
  main { max-width: 460px; margin: 64px auto; background: #fff; border-radius: 8px; padding: 32px; }
  h1 { font-size: 20px; margin: 0 0 16px; }
  p { font-size: 15px; line-height: 1.5; margin: 0 0 16px; }
  .muted { font-size: 13px; color: #666; }
  button { background: #2563eb; color: #fff; border: 0; border-radius: 6px; font-size: 15px; padding: 12px 20px; cursor: pointer; }
</style>
</head>
<body><main><h1>${esc(title)}</h1>${html}</main></body>
</html>`;
  return new NextResponse(doc, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
}

/** Есть ли в адресе ссылка RU-сброса — тогда запрос обрабатывает этот модуль. */
export function isRuResetRequest(req: NextRequest): boolean {
  return req.nextUrl.searchParams.has(RU_RESET_PARAM);
}

/** GET по ссылке из письма: страница с кнопкой, пароль ещё не меняется. */
export async function ruResetPageResponse(req: NextRequest): Promise<NextResponse> {
  const check = await checkToken(req.nextUrl.searchParams.get(RU_RESET_PARAM), Date.now());
  if (!check.ok) return pageResponse({ kind: check.reason });
  return pageResponse({ kind: 'form', token: check.token });
}

/** POST по кнопке: меняем пароль и присылаем новый, как раньше. */
export async function ruResetSubmitResponse(req: NextRequest): Promise<NextResponse> {
  const check = await checkToken(req.nextUrl.searchParams.get(RU_RESET_PARAM), Date.now());
  if (!check.ok) return pageResponse({ kind: check.reason });
  if (!supabaseAdmin) return pageResponse({ kind: 'unavailable' });

  const logMeta = { userId: check.userId, route: RESET_PATH };
  const { data: profile } = await supabaseAdmin.from('profiles').select('email').eq('id', check.userId).maybeSingle();
  const to = (profile?.email as string | null | undefined) ?? null;
  if (!to) {
    await logError('auth.forgot.ru_confirm.no_email', null, {}, logMeta);
    return pageResponse({ kind: 'failed' });
  }

  const newPassword = generateStrongPassword(14);
  const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(check.userId, { password: newPassword });
  if (updateErr) {
    await logError('auth.forgot.update.failed', updateErr, {}, logMeta);
    return pageResponse({ kind: 'failed' });
  }

  const { subject, html, text } = renderPasswordResetEmail({ password: newPassword, resetAtMsk: formatMoscowTime(new Date()) });
  try {
    await sendTransactionalEmail({ to, subject, html, text });
    await logAudit('auth.forgot.success', 'Password reset confirmed by link, new password emailed', { to }, logMeta);
  } catch (err) {
    // Пароль уже сменён: повторный запрос сброса пришлёт новую ссылку.
    await logError('auth.forgot.email.failed', err, { to }, logMeta);
    return pageResponse({ kind: 'failed' });
  }
  return pageResponse({ kind: 'done' });
}

export function formatMoscowTime(d: Date): string {
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

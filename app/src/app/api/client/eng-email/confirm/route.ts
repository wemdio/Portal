import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logWarn } from '@/lib/loggerServer';
import { consumeHeEngEmailToken, type HeEngConsumeOutcome } from '@/lib/hypothesisEngine/engEmailVerification';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/client/eng-email/confirm?token=… — ссылка из письма подтверждения
 * почты ENG-клиента (lib/email/templates/engEmailVerification.ts).
 *
 * БЕЗ СЕССИИ — намеренно. Письмо чаще открывают на телефоне, где кабинет не
 * открыт; доказательство здесь — сама ссылка: её получил только владелец
 * ящика, она подписана, со сроком и одноразовая
 * (lib/hypothesisEngine/engEmailVerification.ts). Middleware пропускает
 * `/api/client/*` без сессии (isClientApiPath) — проверку делает этот роут.
 *
 * Почему `/api/client/eng-email`, а не `/api/client/eng`: правило архитектуры
 * (tests/architecture/verticalEngineV2Isolation.test.ts) требует от каждого
 * хендлера `/api/client/eng` сессию, рыночный гейт и скоуп владельца объекта
 * he_*. У ссылки из письма сессии нет по смыслу, а соседние status и resend —
 * про аккаунт, а не про объект he_*: сессия и рыночный гейт у них есть, а
 * скоуп — сам id пользователя сессии, чужих строк они не читают.
 *
 * Ответ — готовая английская страница (HTML), а не JSON и не редирект на
 * страницу кабинета: страница кабинета требует входа, и без сессии клиент
 * увидел бы форму входа вместо результата.
 *
 * GET меняет состояние. Сканер ссылок почтового сервера может перейти по ней
 * раньше человека — тогда почту подтвердил ящик, в который письмо и пришло, а
 * человек увидит «Your email is already confirmed». Подтвердить чужой аккаунт
 * этим нельзя: ссылка уходит только на адрес аккаунта.
 */

interface ResultCopy {
  status: number;
  title: string;
  body: string;
  action: { label: string; href: string };
}

const OPEN_ACCOUNT = { label: 'Open your account', href: '/client/eng' };
const NEW_LINK = { label: 'Send a new link', href: '/client/eng/verify-email' };

const RESULT: Record<HeEngConsumeOutcome, ResultCopy> = {
  verified: {
    status: 200,
    title: 'Your email is confirmed',
    body: 'Research, contact collection, letters and launches no longer wait for this confirmation.',
    action: OPEN_ACCOUNT,
  },
  already_verified: {
    status: 200,
    title: 'Your email is already confirmed',
    body: 'There is nothing else to do with this link.',
    action: OPEN_ACCOUNT,
  },
  expired: {
    status: 410,
    title: 'This link has expired',
    body: 'Confirmation links work for 48 hours. Sign in and send yourself a new one.',
    action: NEW_LINK,
  },
  superseded: {
    status: 410,
    title: 'A newer link was sent',
    body: 'This link was replaced by a newer one. Open the most recent confirmation email, or sign in and send a new link.',
    action: NEW_LINK,
  },
  invalid: {
    status: 400,
    title: 'This link is not valid',
    body: 'The link may be cut off or changed. Copy the whole link from the email, or sign in and send a new one.',
    action: NEW_LINK,
  },
  unavailable: {
    status: 503,
    title: 'We could not confirm your email right now',
    body: 'Please open the link again later.',
    action: OPEN_ACCOUNT,
  },
};

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function page(copy: ResultCopy): NextResponse {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${esc(copy.title)} — outreachOS</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
  <main style="max-width:480px;margin:64px auto;padding:0 16px;">
    <div style="background:#ffffff;border-radius:8px;padding:32px;">
      <p style="font-size:13px;letter-spacing:0.04em;text-transform:uppercase;color:#666;margin:0 0 12px;">outreachOS</p>
      <h1 style="font-size:22px;margin:0 0 12px;">${esc(copy.title)}</h1>
      <p style="font-size:15px;line-height:1.5;margin:0 0 24px;color:#333;">${esc(copy.body)}</p>
      <a href="${esc(copy.action.href)}" style="display:inline-block;background:#1a1a1a;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 20px;border-radius:6px;">${esc(copy.action.label)}</a>
    </div>
  </main>
</body>
</html>`;
  return new NextResponse(html, {
    status: copy.status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // Ссылка несёт токен: со страницы результата он не должен уехать
      // заголовком Referer ни на один переход.
      'Referrer-Policy': 'no-referrer',
    },
  });
}

export async function GET(req: NextRequest) {
  if (!supabaseAdmin) return page(RESULT.unavailable);
  const token = req.nextUrl.searchParams.get('token');
  const { outcome, userId, reason } = await consumeHeEngEmailToken(supabaseAdmin, token);
  if (outcome === 'verified') {
    void logAudit('client.eng.verify_email.confirmed', 'ENG email confirmed by link', { userId });
  } else if (outcome === 'unavailable') {
    void logWarn('client.eng.verify_email.unavailable', `ENG email confirmation unavailable: ${reason ?? 'unknown'}`, { userId });
  }
  return page(RESULT[outcome]);
}

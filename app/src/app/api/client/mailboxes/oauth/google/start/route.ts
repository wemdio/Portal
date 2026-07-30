import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';
import { requireByoMailboxClient } from '@/lib/byoMailbox/access';
import {
  buildGoogleAuthUrl,
  signOAuthState,
  callbackRedirectUri,
  getGoogleClientCreds,
} from '@/lib/byoMailbox/googleOAuth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/client/mailboxes/oauth/google/start — начинает OAuth.
 * Вызывается клиентом по fetch с Bearer-токеном, возвращает { url } на consent-страницу
 * Google. Сам редирект на Google делает фронт (window.location = url), поэтому Bearer
 * остаётся на этом запросе, а на колбэке нас опознаёт подписанный state.
 */
export async function GET(req: NextRequest) {
  const res = await requireByoMailboxClient(req);
  if ('error' in res) return res.error;

  // Под демо OAuth-флоу не начинаем: выданный state приведёт на callback,
  // который запишет ящик в реальный аккаунт (ревью 27.07).
  if (res.auth.isDemo) {
    return NextResponse.json(
      { error: 'Демо-режим: подключение почты недоступно на витрине.', code: 'DEMO_READONLY' },
      { status: 403 },
    );
  }

  try {
    getGoogleClientCreds();
  } catch {
    return NextResponse.json(
      { error: 'Google OAuth не настроен на сервере (нет GOOGLE_OAUTH_CLIENT_ID/SECRET).', code: 'OAUTH_NOT_CONFIGURED' },
      { status: 503 },
    );
  }

  const redirectUri = callbackRedirectUri(req.nextUrl.origin);
  const state = signOAuthState(res.auth.userId, Date.now());
  return NextResponse.json({ url: buildGoogleAuthUrl(redirectUri, state) });
}

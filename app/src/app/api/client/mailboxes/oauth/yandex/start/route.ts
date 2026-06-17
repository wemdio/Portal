import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';
import { requireByoMailboxClient } from '@/lib/byoMailbox/access';
import { signOAuthState } from '@/lib/byoMailbox/googleOAuth';
import {
  buildYandexAuthUrl,
  yandexCallbackRedirectUri,
  getYandexClientCreds,
} from '@/lib/byoMailbox/yandexOAuth';

export const dynamic = 'force-dynamic';

/** GET /api/client/mailboxes/oauth/yandex/start — отдаёт URL согласия Яндекса. */
export async function GET(req: NextRequest) {
  const res = await requireByoMailboxClient(req);
  if ('error' in res) return res.error;

  try {
    getYandexClientCreds();
  } catch {
    return NextResponse.json(
      { error: 'Yandex OAuth не настроен на сервере (нет YANDEX_OAUTH_CLIENT_ID/SECRET).', code: 'OAUTH_NOT_CONFIGURED' },
      { status: 503 },
    );
  }

  const redirectUri = yandexCallbackRedirectUri(req.nextUrl.origin);
  const state = signOAuthState(res.auth.userId, Date.now());
  return NextResponse.json({ url: buildYandexAuthUrl(redirectUri, state) });
}

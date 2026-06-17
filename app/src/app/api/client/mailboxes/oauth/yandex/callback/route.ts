import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isByoMailboxEnabled } from '@/lib/byoMailbox/access';
import { verifyOAuthState } from '@/lib/byoMailbox/googleOAuth';
import {
  exchangeYandexCode,
  getYandexUserEmail,
  yandexCallbackRedirectUri,
} from '@/lib/byoMailbox/yandexOAuth';
import { sealMailboxSecret } from '@/lib/byoMailbox/credentials';
import { verifyOAuthTokenSmtp } from '@/lib/byoMailbox/smtp';
import { logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

function backTo(origin: string, query: string) {
  return NextResponse.redirect(`${origin}/client/mailboxes?${query}`);
}

/** GET /api/client/mailboxes/oauth/yandex/callback — Яндекс редиректит сюда. */
export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const sp = req.nextUrl.searchParams;

  const oauthError = sp.get('error');
  if (oauthError) return backTo(origin, 'oauth_error=' + encodeURIComponent(oauthError));

  const code = sp.get('code');
  const state = sp.get('state');
  if (!code || !state) return backTo(origin, 'oauth_error=missing_code');

  const userId = verifyOAuthState(state, Date.now());
  if (!userId) return backTo(origin, 'oauth_error=bad_state');
  if (!(await isByoMailboxEnabled(userId))) return backTo(origin, 'oauth_error=not_in_pilot');
  if (!supabaseAdmin) return backTo(origin, 'oauth_error=server');

  try {
    const redirectUri = yandexCallbackRedirectUri(origin);
    const { refreshToken, accessToken } = await exchangeYandexCode(code, redirectUri);
    const email = await getYandexUserEmail(accessToken);

    // Проверяем SMTP по Yandex XOAUTH2 до сохранения.
    const v = await verifyOAuthTokenSmtp({ host: 'smtp.yandex.ru', port: 465, secure: true, user: email, accessToken });
    if (!v.ok) {
      await logError('byoMailbox.oauth.verify_failed', new Error(v.error || 'verify failed'), { userId, email, provider: 'yandex' });
      return backTo(origin, 'oauth_error=smtp_verify');
    }

    const nowIso = new Date().toISOString();
    const { error } = await supabaseAdmin
      .from('client_mailbox_accounts')
      .upsert(
        {
          client_user_id: userId,
          email,
          provider: 'yandex',
          auth_type: 'oauth_yandex',
          smtp_host: 'smtp.yandex.ru',
          smtp_port: 465,
          smtp_secure: true,
          imap_host: 'imap.yandex.ru',
          imap_port: 993,
          username: email,
          secret_encrypted: sealMailboxSecret({ oauthRefreshToken: refreshToken }),
          status: 'verified',
          last_verified_at: nowIso,
          last_error: null,
          updated_at: nowIso,
        },
        { onConflict: 'client_user_id,email' },
      );
    if (error) {
      await logError('byoMailbox.oauth.save_failed', new Error(error.message), { userId, email, provider: 'yandex' });
      return backTo(origin, 'oauth_error=save');
    }

    return backTo(origin, 'connected=' + encodeURIComponent(email));
  } catch (e) {
    await logError('byoMailbox.oauth.callback_failed', e instanceof Error ? e : new Error(String(e)), { userId, provider: 'yandex' });
    return backTo(origin, 'oauth_error=exchange');
  }
}

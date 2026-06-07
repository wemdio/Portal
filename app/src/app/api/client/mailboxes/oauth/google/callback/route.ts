import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isByoMailboxEnabled } from '@/lib/byoMailbox/access';
import {
  verifyOAuthState,
  exchangeCodeForTokens,
  getGoogleUserEmail,
  callbackRedirectUri,
} from '@/lib/byoMailbox/googleOAuth';
import { sealMailboxSecret } from '@/lib/byoMailbox/credentials';
import { verifyOAuthGmail } from '@/lib/byoMailbox/smtp';
import { logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

/**
 * GET /api/client/mailboxes/oauth/google/callback — Google редиректит сюда (браузерный
 * переход, без Bearer). Доверяем подписанному state. Меняем code на refresh_token,
 * проверяем SMTP по OAuth, сохраняем ящик и возвращаем клиента на /client/mailboxes.
 */
function backTo(origin: string, query: string) {
  return NextResponse.redirect(`${origin}/client/mailboxes?${query}`);
}

export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const sp = req.nextUrl.searchParams;

  const googleError = sp.get('error');
  if (googleError) return backTo(origin, 'oauth_error=' + encodeURIComponent(googleError));

  const code = sp.get('code');
  const state = sp.get('state');
  if (!code || !state) return backTo(origin, 'oauth_error=missing_code');

  const userId = verifyOAuthState(state, Date.now());
  if (!userId) return backTo(origin, 'oauth_error=bad_state');
  if (!(await isByoMailboxEnabled(userId))) return backTo(origin, 'oauth_error=not_in_pilot');
  if (!supabaseAdmin) return backTo(origin, 'oauth_error=server');

  try {
    const redirectUri = callbackRedirectUri(origin);
    const { refreshToken, accessToken } = await exchangeCodeForTokens(code, redirectUri);
    const email = await getGoogleUserEmail(accessToken);

    // Проверяем SMTP по OAuth до сохранения — чтобы не сохранять нерабочий ящик.
    const v = await verifyOAuthGmail({ email, refreshToken });
    if (!v.ok) {
      await logError('byoMailbox.oauth.verify_failed', new Error(v.error || 'verify failed'), { userId, email });
      return backTo(origin, 'oauth_error=smtp_verify');
    }

    const nowIso = new Date().toISOString();
    const { error } = await supabaseAdmin
      .from('client_mailbox_accounts')
      .upsert(
        {
          client_user_id: userId,
          email,
          provider: 'gmail',
          auth_type: 'oauth_google',
          smtp_host: 'smtp.gmail.com',
          smtp_port: 465,
          smtp_secure: true,
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
      await logError('byoMailbox.oauth.save_failed', new Error(error.message), { userId, email });
      return backTo(origin, 'oauth_error=save');
    }

    return backTo(origin, 'connected=' + encodeURIComponent(email));
  } catch (e) {
    await logError('byoMailbox.oauth.callback_failed', e instanceof Error ? e : new Error(String(e)), { userId });
    return backTo(origin, 'oauth_error=exchange');
  }
}

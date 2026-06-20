import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth } from '@/lib/clientApiHelper';
import { createLinkToken } from '@/lib/telegramAgent/linkToken';
import {
  getClientRepliesBotToken,
  getClientRepliesBotUsername,
  isClientRepliesBotConfigured,
} from '@/lib/clientReplyBot/bot';

export const dynamic = 'force-dynamic';

/**
 * Mints a short-lived deep-link the client opens to connect their Telegram to
 * the replies bot. The token is a stateless HMAC over the client's user id,
 * signed with the bot token, so the webhook can trust it without DB state.
 */
export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;

  if (!isClientRepliesBotConfigured()) {
    return NextResponse.json({ bot_configured: false });
  }

  const token = createLinkToken(result.auth.userId, getClientRepliesBotToken());
  const deeplink = `https://t.me/${getClientRepliesBotUsername()}?start=lnk${token}`;

  return NextResponse.json({ bot_configured: true, deeplink, expires_in: 600 });
}

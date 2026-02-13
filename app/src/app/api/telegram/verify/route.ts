import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { createTelegramLinkToken, verifyTelegramInitData } from '@/lib/telegram';

import { TELEGRAM_BOT_TOKEN, TELEGRAM_INITDATA_MAX_AGE_SECONDS } from '@/lib/constants';

function jsonError(message: string, status: number) {
  return NextResponse.json({ verified: false, error: message }, { status });
}

export async function POST(req: NextRequest) {
  if (!TELEGRAM_BOT_TOKEN) return jsonError('Telegram bot token is not configured', 500);

  let body: { init_data?: string };
  try {
    body = (await req.json()) as { init_data?: string };
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  if (!body?.init_data || typeof body.init_data !== 'string') {
    return jsonError('Missing init_data', 400);
  }

  const verified = verifyTelegramInitData(body.init_data, TELEGRAM_BOT_TOKEN, TELEGRAM_INITDATA_MAX_AGE_SECONDS);
  if (!verified.ok) return jsonError(verified.error, 401);
  if (!verified.user?.id) return jsonError('Missing Telegram user', 400);

  const { token, expiresAt } = createTelegramLinkToken(String(verified.user.id), verified.authDate, TELEGRAM_BOT_TOKEN);

  return NextResponse.json({
    verified: true,
    telegram_user: verified.user,
    link_token: token,
    link_expires_at: expiresAt,
  });
}

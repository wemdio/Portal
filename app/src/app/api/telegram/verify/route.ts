import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { createTelegramLinkToken, verifyTelegramInitData } from '@/lib/telegram';

const INITDATA_MAX_AGE_SECONDS = 300;

function jsonError(message: string, status: number) {
  return NextResponse.json({ verified: false, error: message }, { status });
}

export async function POST(req: NextRequest) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return jsonError('Telegram bot token is not configured', 500);

  let body: { init_data?: string };
  try {
    body = (await req.json()) as { init_data?: string };
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  if (!body?.init_data || typeof body.init_data !== 'string') {
    return jsonError('Missing init_data', 400);
  }

  const verified = verifyTelegramInitData(body.init_data, botToken, INITDATA_MAX_AGE_SECONDS);
  if (!verified.ok) return jsonError(verified.error, 401);
  if (!verified.user?.id) return jsonError('Missing Telegram user', 400);

  const { token, expiresAt } = createTelegramLinkToken(String(verified.user.id), verified.authDate, botToken);

  return NextResponse.json({
    verified: true,
    telegram_user: verified.user,
    link_token: token,
    link_expires_at: expiresAt,
  });
}

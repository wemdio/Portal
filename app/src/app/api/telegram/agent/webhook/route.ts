import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { handleAgentMessage } from '@/lib/telegramAgent/agent';
import { logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let update: Record<string, unknown>;
  try {
    update = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }

  const msg = update.message as
    | { message_id: number; chat: { id: number }; from?: { id: number }; text?: string }
    | undefined;

  if (msg?.text && msg?.from?.id) {
    void handleAgentMessage(msg).catch((err) => logError('telegram-agent.webhook.error', err));
  }

  return NextResponse.json({ ok: true });
}

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { handleAgentMessage, handleCallbackQuery } from '@/lib/telegramAgent/agent';
import { logError } from '@/lib/loggerServer';
import { isInAppBotEnabled } from '@/lib/adminBots/inAppState';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const enabled = await isInAppBotEnabled('tg-agent');
  if (!enabled) {
    return NextResponse.json({ ok: true });
  }

  let update: Record<string, unknown>;
  try {
    update = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }

  const msg = update.message as
    | { message_id: number; chat: { id: number }; from?: { id: number }; text?: string; voice?: { file_id: string; duration: number } }
    | undefined;

  const cbq = update.callback_query as
    | { id: string; from: { id: number }; message?: { chat: { id: number }; message_id: number }; data?: string }
    | undefined;

  const tasks: Promise<void>[] = [];

  if (msg?.from?.id && (msg.text || msg.voice)) {
    tasks.push(handleAgentMessage(msg).catch((err) => logError('telegram-agent.webhook.error', err)));
  }

  if (cbq) {
    tasks.push(handleCallbackQuery(cbq).catch((err) => logError('telegram-agent.callback.webhook.error', err)));
  }

  if (tasks.length > 0) {
    await Promise.all(tasks);
  }

  return NextResponse.json({ ok: true });
}

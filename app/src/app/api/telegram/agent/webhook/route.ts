import { NextResponse, after } from 'next/server';
import type { NextRequest } from 'next/server';
import { handleAgentMessage, handleCallbackQuery } from '@/lib/telegramAgent/agent';
import { logError } from '@/lib/loggerServer';
import { isInAppBotEnabled } from '@/lib/adminBots/inAppState';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const recentMessages = new Set<string>();
const DEDUP_TTL_MS = 180_000;

function isDuplicate(chatId: number, messageId: number): boolean {
  const key = `${chatId}:${messageId}`;
  if (recentMessages.has(key)) return true;
  recentMessages.add(key);
  setTimeout(() => recentMessages.delete(key), DEDUP_TTL_MS);
  return false;
}

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
    | {
      message_id: number;
      chat: { id: number };
      from?: { id: number; username?: string; first_name?: string; last_name?: string };
      text?: string;
      voice?: { file_id: string; duration: number };
    }
    | undefined;

  if (msg?.from?.id && (msg.text || msg.voice)) {
    if (!isDuplicate(msg.chat.id, msg.message_id)) {
      after(async () => {
        await handleAgentMessage(msg).catch((err) => logError('telegram-agent.webhook.error', err));
      });
    }
  }

  const cbq = update.callback_query as
    | { id: string; from: { id: number }; message?: { chat: { id: number }; message_id: number }; data?: string }
    | undefined;

  if (cbq) {
    after(async () => {
      await handleCallbackQuery(cbq).catch((err) => logError('telegram-agent.callback.webhook.error', err));
    });
  }

  return NextResponse.json({ ok: true });
}

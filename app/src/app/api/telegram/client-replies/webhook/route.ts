import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { handleClientReplyBotMessage, type ClientReplyBotMessage } from '@/lib/clientReplyBot/handleUpdate';
import { logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

// Telegram retries failed deliveries — dedup by chat+message id within a window.
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
  let update: { message?: ClientReplyBotMessage };
  try {
    update = (await req.json()) as { message?: ClientReplyBotMessage };
  } catch {
    return NextResponse.json({ ok: true });
  }

  const msg = update.message;
  if (!msg?.chat?.id || typeof msg.text !== 'string') {
    return NextResponse.json({ ok: true });
  }
  if (isDuplicate(msg.chat.id, msg.message_id)) {
    return NextResponse.json({ ok: true });
  }

  try {
    await handleClientReplyBotMessage(msg);
  } catch (err) {
    await logError('client-replies-bot.webhook.error', err);
  }

  return NextResponse.json({ ok: true });
}

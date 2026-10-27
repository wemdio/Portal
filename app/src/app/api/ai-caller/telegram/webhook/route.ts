import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

/**
 * Вебхук бота AI-звонилки: запоминает чаты, куда бота добавили, — из них
 * звонилка выбирает, куда слать отчёты. Кнопки согласования баз («Проверка
 * баз») этот вебхук обрабатывал до 27.10.2026; инструмент удалён.
 */

async function handleChatDiscovery(update: Record<string, unknown>) {
  if (!supabaseAdmin) return;

  const chatMember = update.my_chat_member as Record<string, unknown> | undefined;
  if (chatMember?.chat) {
    const chat = chatMember.chat as Record<string, unknown>;
    const status = (chatMember.new_chat_member as Record<string, unknown>)?.status as string;
    const kicked = ['kicked', 'left'].includes(status);
    if (chat.id && !kicked) {
      await supabaseAdmin.from('ai_caller_tg_chats').upsert({
        chat_id: chat.id,
        title: (chat.title as string) || `Chat ${chat.id}`,
        type: (chat.type as string) || 'group',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'chat_id' });
    } else if (chat.id && kicked) {
      await supabaseAdmin.from('ai_caller_tg_chats').delete().eq('chat_id', chat.id);
    }
  }

  const msg = update.message as Record<string, unknown> | undefined;
  if (msg?.chat) {
    const chat = msg.chat as Record<string, unknown>;
    if (chat.id) {
      await supabaseAdmin.from('ai_caller_tg_chats').upsert({
        chat_id: chat.id,
        title: (chat.title as string) || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || `Chat ${chat.id}`,
        type: (chat.type as string) || 'unknown',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'chat_id' });
    }
  }
}

/** POST: Telegram webhook endpoint */
export async function POST(req: NextRequest) {
  let update: Record<string, unknown>;
  try {
    update = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }

  try {
    await handleChatDiscovery(update);
  } catch (err) {
    await logError('telegram.webhook.error', err);
  }

  return NextResponse.json({ ok: true });
}

import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { supabaseInstantly } from '@/lib/supabaseInstantly';

export const dynamic = 'force-dynamic';

const TG_TIMEOUT = 8_000;

function getToken(): string {
  return process.env.TELEGRAM_ATMOS_BOT_TOKEN ?? '';
}

async function tgApi<T>(method: string, params?: Record<string, unknown>): Promise<T | null> {
  const token = getToken();
  if (!token) return null;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: params ? JSON.stringify(params) : undefined,
      signal: AbortSignal.timeout(TG_TIMEOUT),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { ok: boolean; result?: T };
    return json.ok ? (json.result ?? null) : null;
  } catch {
    return null;
  }
}

interface TgChat {
  id: number;
  title?: string;
  type: string;
}

/**
 * GET /api/instantly/bot-chats
 * Returns known Telegram chats from DB.
 *
 * GET /api/instantly/bot-chats?verify=<chat_id>
 * Verifies a specific chat_id via Telegram API (getChat) and stores it if valid.
 */
export const GET = withAuth(async (req, user) => {
  if (!supabaseInstantly) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const url = new URL(req.url);
  const verifyChatId = url.searchParams.get('verify');

  if (verifyChatId) {
    const chatId = Number(verifyChatId);
    if (!chatId || isNaN(chatId)) {
      return NextResponse.json({ error: 'Invalid chat_id' }, { status: 400 });
    }

    const chat = await tgApi<TgChat>('getChat', { chat_id: chatId });
    if (!chat) {
      return NextResponse.json({ error: 'Бот не состоит в этом чате или chat_id неверный' }, { status: 404 });
    }

    await supabaseInstantly
      .from('bot_known_chats')
      .upsert(
        { chat_id: chat.id, chat_title: chat.title ?? `Chat ${chat.id}`, chat_type: chat.type, added_by: user.id },
        { onConflict: 'chat_id' },
      );

    return NextResponse.json({ chat: { chat_id: chat.id, title: chat.title ?? `Chat ${chat.id}`, type: chat.type } });
  }

  const { data, error } = await supabaseInstantly
    .from('bot_known_chats')
    .select('chat_id, chat_title, chat_type, created_at')
    .order('chat_title', { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ chats: data ?? [] });
});

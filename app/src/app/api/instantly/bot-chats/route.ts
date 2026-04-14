import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { supabaseInstantly } from '@/lib/supabaseInstantly';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const TG_TIMEOUT = 10_000;

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

interface TgUpdate {
  message?: { chat: TgChat };
  my_chat_member?: { chat: TgChat };
}

interface TgWebhookInfo {
  url?: string;
}

/**
 * Scans Telegram for chats the bot is in:
 * 1. Gets current webhook URL
 * 2. Temporarily deletes webhook
 * 3. Calls getUpdates to discover chats
 * 4. Restores webhook
 * 5. Stores discovered chats in DB
 */
async function scanBotChats(userId: string): Promise<{ discovered: number; chats: { chat_id: number; chat_title: string }[] }> {
  if (!supabaseInstantly) return { discovered: 0, chats: [] };

  const webhookInfo = await tgApi<TgWebhookInfo>('getWebhookInfo');
  const webhookUrl = webhookInfo?.url || '';

  if (webhookUrl) {
    await tgApi('deleteWebhook');
  }

  const updates = await tgApi<TgUpdate[]>('getUpdates', { limit: 100, timeout: 0 });

  if (webhookUrl) {
    await tgApi('setWebhook', {
      url: webhookUrl,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false,
    });
  }

  if (!updates || updates.length === 0) return { discovered: 0, chats: [] };

  const chatMap = new Map<number, string>();
  for (const u of updates) {
    const chat = u.message?.chat ?? u.my_chat_member?.chat;
    if (chat && chat.type !== 'private' && chat.title) {
      chatMap.set(chat.id, chat.title);
    }
  }

  if (chatMap.size === 0) return { discovered: 0, chats: [] };

  const rows = Array.from(chatMap.entries()).map(([chatId, title]) => ({
    chat_id: chatId,
    chat_title: title,
    chat_type: 'group',
    added_by: userId,
  }));

  await supabaseInstantly
    .from('bot_known_chats')
    .upsert(rows, { onConflict: 'chat_id' });

  return {
    discovered: rows.length,
    chats: rows.map((r) => ({ chat_id: r.chat_id, chat_title: r.chat_title })),
  };
}

/**
 * GET /api/instantly/bot-chats
 *   Returns known Telegram chats. Auto-scans if DB is empty.
 *
 * GET /api/instantly/bot-chats?scan=true
 *   Force re-scan chats from Telegram.
 *
 * GET /api/instantly/bot-chats?verify=<chat_id>
 *   Verifies a specific chat_id via getChat and stores it.
 */
export const GET = withAuth(async (req, user) => {
  if (!supabaseInstantly) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const url = new URL(req.url);
  const forceScan = url.searchParams.get('scan') === 'true';
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

  // Check existing chats first
  const { data: existing } = await supabaseInstantly
    .from('bot_known_chats')
    .select('chat_id, chat_title, chat_type, created_at')
    .order('chat_title', { ascending: true });

  const isEmpty = !existing || existing.length === 0;

  // Auto-scan on first load or forced scan
  if (forceScan || isEmpty) {
    const scanResult = await scanBotChats(user.id);

    if (scanResult.discovered > 0 || forceScan) {
      const { data: refreshed } = await supabaseInstantly
        .from('bot_known_chats')
        .select('chat_id, chat_title, chat_type, created_at')
        .order('chat_title', { ascending: true });

      return NextResponse.json({
        chats: refreshed ?? [],
        scanned: true,
        discovered: scanResult.discovered,
      });
    }
  }

  return NextResponse.json({ chats: existing ?? [] });
});

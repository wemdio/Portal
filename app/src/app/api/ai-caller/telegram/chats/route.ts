import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

const TG_TOKEN = process.env.AI_CALLER_TG_BOT_TOKEN ?? '';
const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;

/** GET — список чатов, в которых состоит бот */
export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!TG_TOKEN) {
    return NextResponse.json({ error: 'AI_CALLER_TG_BOT_TOKEN не настроен' }, { status: 500 });
  }

  // Use admin client to bypass RLS (shared resource)
  const db = supabaseAdmin ?? supabase;

  const allChats = new Map<number, { id: number; title: string; type: string }>();

  // 1) Load saved chats from DB
  try {
    const { data: savedChats } = await db
      .from('ai_caller_tg_chats')
      .select('chat_id, title, type');

    if (savedChats) {
      for (const sc of savedChats) {
        allChats.set(sc.chat_id, { id: sc.chat_id, title: sc.title, type: sc.type || 'group' });
      }
    }
  } catch {
    // DB read failed — not critical
  }

  // 2) Discover new chats from getUpdates
  try {
    const res = await fetch(`${TG_API}/getUpdates?limit=100`);
    const data = await res.json();

    if (data.ok && Array.isArray(data.result)) {
      const latestStatus = new Map<number, string>();

      for (const update of data.result) {
        if (update.my_chat_member) {
          const chat = update.my_chat_member.chat;
          const status: string = update.my_chat_member.new_chat_member?.status ?? '';
          if (chat?.id) {
            latestStatus.set(chat.id, status);
            allChats.set(chat.id, {
              id: chat.id,
              title: chat.title || `Chat ${chat.id}`,
              type: chat.type || 'group',
            });
          }
        }

        if (update.message?.chat) {
          const chat = update.message.chat;
          if (chat.id && !allChats.has(chat.id)) {
            allChats.set(chat.id, {
              id: chat.id,
              title: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || `Chat ${chat.id}`,
              type: chat.type || 'unknown',
            });
          }
          if (!latestStatus.has(chat.id)) {
            latestStatus.set(chat.id, 'member');
          }
        }
      }

      const removedStatuses = new Set(['kicked', 'left']);
      for (const [chatId, status] of latestStatus) {
        if (removedStatuses.has(status)) {
          allChats.delete(chatId);
        }
      }
    }
  } catch {
    // getUpdates failed — fall back to DB-only results
  }

  // 3) Persist discovered chats
  const chatList = Array.from(allChats.values());
  if (chatList.length > 0) {
    try {
      await db.from('ai_caller_tg_chats').upsert(
        chatList.map((c) => ({ chat_id: c.id, title: c.title, type: c.type, updated_at: new Date().toISOString() })),
        { onConflict: 'chat_id' },
      );
    } catch {
      // not critical
    }
  }

  chatList.sort((a, b) => a.title.localeCompare(b.title));

  return NextResponse.json({ chats: chatList });
}

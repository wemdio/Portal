import { NextRequest, NextResponse } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { TG_TOKEN, tgApiBase, ensureTgApiReady } from '@/lib/tgTranscribe';

export const dynamic = 'force-dynamic';

interface TgChat {
  id: number;
  title?: string;
  type?: string;
}

async function fetchChatInfo(chatId: number): Promise<TgChat | null> {
  try {
    const res = await fetch(`${tgApiBase()}/getChat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId }),
    });
    const json = (await res.json()) as { ok: boolean; result?: TgChat };
    return json.ok ? (json.result ?? null) : null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!supabaseAdmin) return NextResponse.json({ chats: [] });

  await ensureTgApiReady();

  const { data: rows } = await supabaseAdmin
    .from('tg_bot_chats')
    .select('*')
    .order('updated_at', { ascending: false });

  const chats = (rows ?? []).map((r: Record<string, unknown>) => ({
    chatId: r.chat_id as number,
    title: (r.title as string) || `Chat ${r.chat_id}`,
    chatType: r.chat_type as string,
    lastMessageId: r.last_message_id as number | null,
  }));

  if (chats.length === 0 && TG_TOKEN) {
    const { data: transcripts } = await supabaseAdmin
      .from('tg_video_transcripts')
      .select('tg_chat_id')
      .limit(100);

    const uniqueIds = [...new Set((transcripts ?? []).map((r: Record<string, unknown>) => Number(r.tg_chat_id)))];

    for (const cid of uniqueIds) {
      const info = await fetchChatInfo(cid);
      if (info) {
        chats.push({
          chatId: info.id,
          title: info.title ?? `Chat ${info.id}`,
          chatType: info.type ?? 'group',
          lastMessageId: null,
        });
        try {
          await supabaseAdmin.from('tg_bot_chats').upsert({
            chat_id: info.id,
            title: info.title ?? '',
            chat_type: info.type ?? 'group',
            updated_at: new Date().toISOString(),
          }, { onConflict: 'chat_id' });
        } catch {
          // ignore
        }
      }
    }
  }

  return NextResponse.json({ chats });
}

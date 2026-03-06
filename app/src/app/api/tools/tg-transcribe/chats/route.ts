import { NextRequest, NextResponse } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!supabaseAdmin) return NextResponse.json({ chats: [] });

  const { data: rows } = await supabaseAdmin
    .from('tg_bot_chats')
    .select('*')
    .order('updated_at', { ascending: false });

  const chats = (rows ?? []).map((r: Record<string, unknown>) => ({
    chatId: r.chat_id as number,
    title: (r.title as string) || `Chat ${r.chat_id}`,
    chatType: r.chat_type as string,
    lastMessageId: r.last_message_id as number | null,
    isForum: (r.is_forum as boolean) ?? false,
    topicId: (r.topic_id as number | null) ?? null,
    topicName: (r.topic_name as string | null) ?? null,
  }));

  return NextResponse.json({ chats });
}

export async function DELETE(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!supabaseAdmin) return NextResponse.json({ error: 'Admin not configured' }, { status: 500 });

  const chatId = req.nextUrl.searchParams.get('chatId');
  const topicId = req.nextUrl.searchParams.get('topicId');

  if (!chatId) return NextResponse.json({ error: 'chatId required' }, { status: 400 });

  const numChatId = Number(chatId);

  if (topicId) {
    const { error } = await supabaseAdmin
      .from('tg_bot_chats')
      .delete()
      .eq('chat_id', numChatId)
      .eq('topic_id', Number(topicId));
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    const { error } = await supabaseAdmin
      .from('tg_bot_chats')
      .delete()
      .eq('chat_id', numChatId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

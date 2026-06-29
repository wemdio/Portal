import { NextRequest, NextResponse } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-transcribe.chats.get' },
    async () => {
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

        const chats = (rows ?? []).map((r: Record<string, unknown>) => {
          const rawTopicId = Number(r.topic_id ?? 0);
          const topicName = (r.topic_name as string | null) ?? null;
          // Legacy semantic: topic_id=0 + no topic_name → chat-level placeholder,
          // expose as null so the dropdown groups it under "whole chat".
          // New semantic: topic_id=0 + topic_name set → a real topic that
          // lives at the General anchor (e.g. renamed "Звонки с клиентами").
          // Surface it as 0 so the scan endpoint forwards a defined filter
          // through to the worker instead of dropping it as "no filter".
          const topicId = rawTopicId > 0 || topicName != null ? rawTopicId : null;
          return {
            chatId: r.chat_id as number,
            title: (r.title as string) || `Chat ${r.chat_id}`,
            chatType: r.chat_type as string,
            lastMessageId: r.last_message_id as number | null,
            isForum: (r.is_forum as boolean) ?? false,
            topicId,
            topicName,
          };
        });

        return NextResponse.json({ chats });
    },
  );
}

export async function DELETE(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-transcribe.chats.delete' },
    async () => {
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
    },
  );
}

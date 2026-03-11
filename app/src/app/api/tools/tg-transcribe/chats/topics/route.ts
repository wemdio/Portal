import { NextRequest, NextResponse } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { tgApiBase, ensureTgApiReady } from '@/lib/tgTranscribe';
import { isMtprotoAvailable, getForumTopicsMtproto } from '@/lib/tgMtprotoDownload';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-transcribe.chats.topics.get' },
    async () => {
      
        const token = getBearerToken(req.headers.get('authorization'));
        if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      
        const supabase = createAuthedSupabaseClient(token);
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      
        const chatId = req.nextUrl.searchParams.get('chatId');
        if (!chatId) return NextResponse.json({ error: 'chatId required' }, { status: 400 });
      
        await ensureTgApiReady();
      
        const numericChatId = Number(chatId);
      
        const chatRes = await fetch(`${tgApiBase()}/getChat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: numericChatId }),
          signal: AbortSignal.timeout(5000),
        });
      
        const chatJson = (await chatRes.json()) as {
          ok: boolean;
          result?: { is_forum?: boolean; title?: string };
        };
      
        if (!chatJson.ok || !chatJson.result?.is_forum) {
          return NextResponse.json({ isForum: false, topics: [] });
        }
      
        if (!isMtprotoAvailable()) {
          return NextResponse.json({ isForum: true, topics: [] });
        }
      
        try {
          const topics = await getForumTopicsMtproto(numericChatId);
          console.log(`[tg-topics] Chat ${numericChatId}: found ${topics.length} topics`, topics.map(t => t.title));
          return NextResponse.json({
            isForum: true,
            topics: topics.map((t) => ({
              topicId: t.id,
              name: t.title,
            })),
          });
        } catch (err) {
          console.error(`[tg-topics] Chat ${numericChatId}: error`, err);
          return NextResponse.json({ isForum: true, topics: [] });
        }
    },
  );
}

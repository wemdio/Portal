import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { withToolTrace } from '@/lib/toolTrace';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  TG_TOKEN,
  type TgMessage,
  extractVideoInfo,
  upsertBotChat,
} from '@/lib/tgTranscribe';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-transcribe.webhook.post' },
    async () => {
        if (!TG_TOKEN) {
          return NextResponse.json({ ok: true });
        }

        let update: Record<string, unknown>;
        try {
          update = await req.json();
        } catch {
          return NextResponse.json({ ok: true });
        }
      
        const msg = (update.message ?? update.channel_post) as (TgMessage & { chat: { id: number; title?: string; type?: string } }) | undefined;
        if (!msg) {
          return NextResponse.json({ ok: true });
        }

        await upsertBotChat(msg.chat.id, msg.chat.title ?? '', msg.chat.type ?? 'group', msg.message_id);
        if (supabaseAdmin && msg.message_thread_id != null && msg.message_thread_id !== 0) {
          try {
            await supabaseAdmin
              .from('tg_bot_chats')
              .update({ last_message_id: msg.message_id, updated_at: new Date().toISOString() })
              .eq('chat_id', msg.chat.id)
              .eq('topic_id', msg.message_thread_id);
          } catch {
            // ignore — best-effort topic anchor update
          }
        }

        const videoInfo = extractVideoInfo(msg);
        if (!videoInfo) {
          return NextResponse.json({ ok: true });
        }

        if (supabaseAdmin) {
          await supabaseAdmin
            .from('tg_transcribe_jobs')
            .upsert(
              {
                tg_chat_id: msg.chat.id,
                tg_message_id: msg.message_id,
                topic_id: msg.message_thread_id ?? null,
                status: 'pending',
                payload: { msg, videoInfo },
                updated_at: new Date().toISOString(),
              },
              { onConflict: 'tg_chat_id,tg_message_id', ignoreDuplicates: true },
            );
        }

        return NextResponse.json({ ok: true });
    },
  );
}

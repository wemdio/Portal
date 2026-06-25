import { NextRequest, NextResponse } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/**
 * GET /api/tools/tg-transcribe/transcribed-chats
 *
 * Returns the list of (chat, topic) pairs that have at least one transcript,
 * each annotated with a human-readable name from tg_bot_chats. Used by the
 * UI to populate the chat filter on the transcripts page.
 *
 * Server-side aggregation via tg_transcribed_chat_topic_counts() RPC — a raw
 * select would silently truncate at PostgREST's db-max-rows cap (~1000) once
 * the table grows. Falls back to a paginated .range() loop if the RPC isn't
 * deployed yet (mirrors the pattern in /api/client/companies-search/activity-types).
 */
export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-transcribe.transcribed-chats.get' },
    async () => {
      const token = getBearerToken(req.headers.get('authorization'));
      if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

      const supabase = createAuthedSupabaseClient(token);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

      if (!supabaseAdmin) return NextResponse.json({ chats: [] });

      type Pair = { chatId: number; topicId: number; count: number };
      const pairs = new Map<string, Pair>();

      const rpcRes = await supabaseAdmin.rpc('tg_transcribed_chat_topic_counts');
      if (!rpcRes.error && Array.isArray(rpcRes.data)) {
        for (const row of rpcRes.data) {
          const chatId = Number(row.tg_chat_id);
          const topicId = Number(row.topic_id ?? 0);
          const cnt = Number(row.cnt ?? 0);
          if (!Number.isFinite(chatId) || cnt <= 0) continue;
          pairs.set(`${chatId}:${topicId}`, { chatId, topicId, count: cnt });
        }
      } else {
        // Fallback: RPC migration not applied yet. Paginate through the
        // raw select so we don't silently lose rows past db-max-rows.
        const PAGE = 1000;
        const HARD_CAP = 500_000;
        for (let offset = 0; offset < HARD_CAP; offset += PAGE) {
          const { data: page, error: pageErr } = await supabaseAdmin
            .from('tg_video_transcripts')
            .select('tg_chat_id, topic_id')
            .order('tg_chat_id', { ascending: true })
            .range(offset, offset + PAGE - 1);
          if (pageErr) return NextResponse.json({ error: pageErr.message }, { status: 500 });
          if (!page || page.length === 0) break;
          for (const r of page) {
            const chatId = Number(r.tg_chat_id);
            const topicId = r.topic_id == null ? 0 : Number(r.topic_id);
            const key = `${chatId}:${topicId}`;
            const existing = pairs.get(key);
            if (existing) existing.count++;
            else pairs.set(key, { chatId, topicId, count: 1 });
          }
          if (page.length < PAGE) break;
        }
      }

      const { data: chatRows } = await supabaseAdmin
        .from('tg_bot_chats')
        .select('chat_id, topic_id, title, topic_name');

      const chatMap = new Map<string, { title: string; topicName: string | null }>();
      for (const c of chatRows ?? []) {
        chatMap.set(`${c.chat_id}:${c.topic_id}`, {
          title: (c.title as string) || '',
          topicName: (c.topic_name as string | null) ?? null,
        });
      }

      const items = Array.from(pairs.values()).map(({ chatId, topicId, count }) => {
        const exact = chatMap.get(`${chatId}:${topicId}`);
        const fallback = exact ? null : chatMap.get(`${chatId}:0`);
        const info = exact ?? fallback;
        let displayName = info?.title || `Chat ${chatId}`;
        // When two distinct topics both fall back to the chat-level row,
        // the chips would render identical labels. Suffix to keep them
        // visually distinct.
        if (!exact && topicId > 0) displayName = `${displayName} · topic ${topicId}`;
        return { chatId, topicId, displayName, count };
      });

      items.sort((a, b) => a.displayName.localeCompare(b.displayName, 'ru'));

      return NextResponse.json({ chats: items });
    },
  );
}

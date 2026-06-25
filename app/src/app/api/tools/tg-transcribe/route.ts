import { NextRequest, NextResponse } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

const TEXT_PREVIEW_LEN = 200;
const admin = supabaseAdmin!;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

async function requireUser(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return null;
  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

/**
 * GET /api/tools/tg-transcribe
 * List transcripts. Returns truncated text preview; use ?id=... for full text.
 */
export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-transcribe.get' },
    async () => {
        const user = await requireUser(req);
        if (!user) return jsonError('Необходима авторизация', 401);

        const url = new URL(req.url);

        // Single item full text
        const id = url.searchParams.get('id')?.trim();
        if (id) {
          const { data, error } = await admin
            .from('tg_video_transcripts')
            .select('id, text')
            .eq('id', id)
            .maybeSingle();
          if (error) return jsonError(error.message, 500);
          if (!data) return jsonError('Не найдено', 404);
          return NextResponse.json({ id: data.id, text: data.text });
        }

        // List: lightweight — no full text, no count
        const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '200', 10) || 200, 1), 500);
        const sortParam = url.searchParams.get('sort');
        const sortColumn = sortParam === 'message_date' ? 'tg_message_date' : 'created_at';

        // Optional server-side chat filter. The chip counts in the UI come
        // from /transcribed-chats (full-table aggregate), so client-side
        // filtering against just the latest `limit` rows would frequently
        // produce 0 results despite a positive chip count for chats with old
        // transcripts. Pushing the filter to SQL keeps chip counts and the
        // visible list consistent.
        const chatIdParam = url.searchParams.get('chatId');
        const topicIdParam = url.searchParams.get('topicId');
        const chatIdFilter = chatIdParam ? Number(chatIdParam) : null;
        const topicIdFilter = topicIdParam ? Number(topicIdParam) : null;

        let q = admin
          .from('tg_video_transcripts')
          .select('id, created_at, tg_message_date, tg_chat_id, tg_message_id, topic_id, tg_sender_id, sender_name, caption, filename, file_size_bytes, duration_seconds, text, length, status, error_text')
          .order(sortColumn, { ascending: false, nullsFirst: false })
          .limit(limit);
        if (chatIdFilter && Number.isFinite(chatIdFilter)) {
          q = q.eq('tg_chat_id', chatIdFilter);
          if (topicIdFilter != null && Number.isFinite(topicIdFilter)) {
            // Match transcribed-chats grouping: 0 covers both explicit 0 and
            // legacy NULL records that predate the topic_id column.
            if (topicIdFilter === 0) q = q.or('topic_id.eq.0,topic_id.is.null');
            else q = q.eq('topic_id', topicIdFilter);
          }
        }
        const { data, error } = await q;

        if (error) return jsonError(error.message, 500);

        const items = (data ?? []).map((row) => ({
          ...row,
          text: row.text?.length > TEXT_PREVIEW_LEN
            ? row.text.slice(0, TEXT_PREVIEW_LEN) + '…'
            : row.text,
          hasFullText: (row.text?.length ?? 0) > TEXT_PREVIEW_LEN,
        }));

        return NextResponse.json({ items });
    },
  );
}

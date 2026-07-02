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

        // List: previews only, full text via ?id=.
        //
        // limit=all (what the UI sends) returns EVERY completed transcript.
        // The old behaviour — newest 200 rows — made the client-side search
        // and the sender filter blind to anything older: a transcript from
        // May existed in the DB but was unfindable once a few hundred newer
        // rows piled on top of it. Rows are pulled from Postgres in 1000-row
        // pages (PostgREST caps a single response); previews are cut
        // server-side so the browser payload stays ~0.5 KB per row.
        const limitRaw = url.searchParams.get('limit') ?? 'all';
        const wantAll = limitRaw === 'all' || limitRaw === '0';
        const limit = wantAll
          ? 0
          : Math.min(Math.max(parseInt(limitRaw, 10) || 200, 1), 500);
        const sortParam = url.searchParams.get('sort');
        const sortColumn = sortParam === 'message_date' ? 'tg_message_date' : 'created_at';

        // Optional server-side chat filter — keeps the list consistent with
        // the chip counts from /transcribed-chats (full-table aggregate).
        const chatIdParam = url.searchParams.get('chatId');
        const topicIdParam = url.searchParams.get('topicId');
        const chatIdFilter = chatIdParam ? Number(chatIdParam) : null;
        const topicIdFilter = topicIdParam ? Number(topicIdParam) : null;

        // Optional server-side search (ilike over caption/filename/sender).
        // The UI does client-side search now that it loads everything, but
        // the param stays for API consumers that want a narrower payload.
        const searchParam = (url.searchParams.get('q') ?? '').trim();
        // Commas, parens and backslashes would break PostgREST's or=()
        // syntax — replace with spaces. '*'/'%' just widen the match.
        const safeSearch = searchParam.replace(/[,()\\]/g, ' ').trim().slice(0, 100);

        // Query builders are single-use in supabase-js, and the fetch-all
        // path issues one query per 1000-row page — hence a factory.
        const buildQuery = () => {
          let q = admin
            .from('tg_video_transcripts')
            .select('id, created_at, tg_message_date, tg_chat_id, tg_message_id, topic_id, tg_sender_id, sender_name, caption, filename, file_size_bytes, duration_seconds, text, length, status, error_text')
            // Only real transcripts in the History list. Excluded:
            //   - status='error' (Groq 429s, FILE_REFERENCE_EXPIRED, …) — the
            //     scan worker retries those on the next pass;
            //   - status='skipped_no_audio' / 'skipped_no_speech' — permanent
            //     empty-text markers (stickers, muted recordings) kept in the
            //     DB only so scans stop re-downloading those files.
            .eq('status', 'completed')
            .order(sortColumn, { ascending: false, nullsFirst: false })
            // Stable tiebreak: without it rows sharing a timestamp can swap
            // between range() pages and get duplicated or lost.
            .order('id', { ascending: false });
          if (chatIdFilter && Number.isFinite(chatIdFilter)) {
            q = q.eq('tg_chat_id', chatIdFilter);
            if (topicIdFilter != null && Number.isFinite(topicIdFilter)) {
              // Match transcribed-chats grouping: 0 covers both explicit 0 and
              // legacy NULL records that predate the topic_id column.
              if (topicIdFilter === 0) q = q.or('topic_id.eq.0,topic_id.is.null');
              else q = q.eq('topic_id', topicIdFilter);
            }
          }
          if (safeSearch) {
            const pattern = `*${safeSearch}*`;
            q = q.or(
              `caption.ilike.${pattern},filename.ilike.${pattern},sender_name.ilike.${pattern}`,
            );
          }
          return q;
        };

        type TranscriptRow = Record<string, unknown> & { text?: string | null };
        const rows: TranscriptRow[] = [];
        if (wantAll) {
          const PAGE = 1000;
          const HARD_CAP = 50_000;
          for (let offset = 0; offset < HARD_CAP; offset += PAGE) {
            const { data, error } = await buildQuery().range(offset, offset + PAGE - 1);
            if (error) return jsonError(error.message, 500);
            rows.push(...((data ?? []) as TranscriptRow[]));
            if (!data || data.length < PAGE) break;
          }
        } else {
          const { data, error } = await buildQuery().limit(limit);
          if (error) return jsonError(error.message, 500);
          rows.push(...((data ?? []) as TranscriptRow[]));
        }

        const items = rows.map((row) => {
          const text = typeof row.text === 'string' ? row.text : '';
          return {
            ...row,
            text: text.length > TEXT_PREVIEW_LEN
              ? text.slice(0, TEXT_PREVIEW_LEN) + '…'
              : text,
            hasFullText: text.length > TEXT_PREVIEW_LEN,
          };
        });

        return NextResponse.json({ items });
    },
  );
}

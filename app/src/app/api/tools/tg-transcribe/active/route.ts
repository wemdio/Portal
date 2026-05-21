import { NextRequest, NextResponse } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';
import { getSenderName, type TgMessage, type VideoInfo } from '@/lib/tgTranscribe';

export const dynamic = 'force-dynamic';

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

type JobRow = {
  id: string;
  status: 'pending' | 'running';
  tg_chat_id: number;
  tg_message_id: number;
  created_at: string;
  started_at: string | null;
  payload: { msg?: TgMessage; videoInfo?: VideoInfo } | null;
};

/**
 * GET /api/tools/tg-transcribe/active
 * Returns currently-active webhook transcribe jobs (pending or running) across the system.
 * Used by the UI to show a side panel of "what's being transcribed right now".
 */
export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-transcribe.active.get' },
    async () => {
      const user = await requireUser(req);
      if (!user) return jsonError('Необходима авторизация', 401);

      const { data, error } = await admin
        .from('tg_transcribe_jobs')
        .select('id, status, tg_chat_id, tg_message_id, created_at, started_at, payload')
        .in('status', ['pending', 'running'])
        .order('status', { ascending: true }) // 'pending' < 'running' alphabetically, but we want running first
        .order('created_at', { ascending: true })
        .limit(50);

      if (error) return jsonError(error.message, 500);

      const rows = (data ?? []) as JobRow[];

      // Fetch chat titles for any chat_ids we see (single query)
      const chatIds = Array.from(new Set(rows.map((r) => r.tg_chat_id)));
      const chatTitles = new Map<number, string>();
      if (chatIds.length > 0) {
        const { data: chats } = await admin
          .from('tg_bot_chats')
          .select('chat_id, title')
          .in('chat_id', chatIds);
        for (const c of (chats ?? []) as Array<{ chat_id: number; title: string | null }>) {
          if (c.title) chatTitles.set(c.chat_id, c.title);
        }
      }

      const jobs = rows.map((r) => {
        const msg = r.payload?.msg;
        const videoInfo = r.payload?.videoInfo;
        return {
          id: r.id,
          status: r.status,
          tg_chat_id: r.tg_chat_id,
          tg_message_id: r.tg_message_id,
          created_at: r.created_at,
          started_at: r.started_at,
          sender_name: msg ? getSenderName(msg) : 'Unknown',
          filename: videoInfo?.filename ?? '',
          file_size_bytes: videoInfo?.fileSize ?? null,
          duration_seconds: videoInfo?.duration ?? null,
          chat_title: chatTitles.get(r.tg_chat_id) ?? null,
        };
      });

      // Sort: running first, then pending; within each by created_at asc
      jobs.sort((a, b) => {
        if (a.status !== b.status) return a.status === 'running' ? -1 : 1;
        return a.created_at.localeCompare(b.created_at);
      });

      return NextResponse.json({ jobs });
    },
  );
}

import { NextRequest, NextResponse } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

const admin = supabaseAdmin!;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

async function getUser(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return null;
  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

/**
 * POST /api/tools/tg-transcribe/scan/all
 *
 * Bulk-queues a scan job for every registered (chat, topic) pair. The
 * tg-transcribe worker already processes tg_scan_jobs one at a time
 * (single-flight per process), so we just stuff the queue and let the
 * worker drain it. Scan worker's alreadyProcessed set transparently
 * skips messages that already have a successful transcript, so re-running
 * scan-all is idempotent — only newly-seen videos cost transcription
 * quota.
 *
 * body: { videoCount?: number }
 *   videoCount — videos to scan per (chat, topic). Clamped to [1, 50],
 *   default 50 (matches single-scan ceiling).
 *
 * Returns: { queued: number, skipped: number }
 *   queued — number of new jobs inserted.
 *   skipped — number of (chat, topic) pairs that already had a pending or
 *   running job and weren't requeued.
 */
export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-transcribe.scan.all.post' },
    async () => {
      const user = await getUser(req);
      if (!user) return jsonError('Необходима авторизация', 401);

      let body: { videoCount?: number };
      try {
        body = await req.json();
      } catch {
        body = {};
      }
      const videoCount = Math.min(Math.max(body.videoCount ?? 50, 1), 50);

      const { data: chats, error: chatsErr } = await admin
        .from('tg_bot_chats')
        .select('chat_id, topic_id');
      if (chatsErr) return jsonError(chatsErr.message, 500);
      if (!chats || chats.length === 0) {
        return NextResponse.json({ queued: 0, skipped: 0, message: 'Нет зарегистрированных чатов' });
      }

      // Don't double-queue pairs that already have a pending/running job —
      // the worker would just see them as "already in flight" and produce
      // confusing duplicate entries in the UI.
      const { data: existingJobs } = await admin
        .from('tg_scan_jobs')
        .select('tg_chat_id, topic_id')
        .in('status', ['pending', 'running']);

      const inFlight = new Set<string>();
      for (const j of existingJobs ?? []) {
        const tid = (j.topic_id as number | null) ?? 0;
        inFlight.add(`${j.tg_chat_id}:${tid}`);
      }

      const rowsToInsert: Array<Record<string, unknown>> = [];
      let skipped = 0;
      for (const c of chats) {
        const chatId = Number(c.chat_id);
        const topicId = (c.topic_id as number | null) ?? null;
        const key = `${chatId}:${topicId ?? 0}`;
        if (inFlight.has(key)) {
          skipped++;
          continue;
        }
        rowsToInsert.push({
          tg_chat_id: chatId,
          topic_id: topicId,
          video_count: videoCount,
          user_id: user.id,
        });
      }

      if (rowsToInsert.length === 0) {
        return NextResponse.json({ queued: 0, skipped });
      }

      const { error: insertErr } = await admin.from('tg_scan_jobs').insert(rowsToInsert);
      if (insertErr) return jsonError(insertErr.message, 500);

      return NextResponse.json({ queued: rowsToInsert.length, skipped });
    },
  );
}

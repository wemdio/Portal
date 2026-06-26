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
 * POST /api/tools/tg-transcribe/scan
 * Creates a background scan job and returns immediately.
 *
 * body: { chatId, topicId?, videoCount?, mode? }
 *   mode='limited' (default) — scan last N videos, capped at scanning 2000 messages.
 *     videoCount clamped to [1, 50].
 *   mode='full' — walk the entire chat history (or topic) from newest to oldest until
 *     it hits message_id 0 or user stops the job. videoCount is ignored (stored as 0).
 *
 * Concurrency: another scan on the SAME (chatId, topicId) is rejected with 409, but
 * scans on different chats/topics can proceed in parallel (worker MAX_CONCURRENCY).
 */
export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-transcribe.scan.post' },
    async () => {
        const user = await getUser(req);
        if (!user) return jsonError('Необходима авторизация', 401);

        let body: {
          chatId?: number;
          videoCount?: number;
          topicId?: number | null;
          mode?: 'limited' | 'full';
        };
        try {
          body = await req.json();
        } catch {
          return jsonError('Неверный JSON', 400);
        }

        const chatId = body.chatId;
        const topicId = body.topicId ?? null;
        const mode: 'limited' | 'full' = body.mode === 'full' ? 'full' : 'limited';
        // For 'full' scans videoCount is meaningless — store 0 as a sentinel. For 'limited'
        // keep the historic clamp [1, 50] so a typo can't kick off a 10k-message walk.
        const videoCount =
          mode === 'full' ? 0 : Math.min(Math.max(body.videoCount ?? 5, 1), 50);

        if (!chatId) return jsonError('Необходим chatId', 400);

        // Per-(chat, topic) lock: scans on DIFFERENT chats can run in parallel — the
        // worker's MAX_CONCURRENCY decides how many actually run at once. We only block
        // duplicate scans of the SAME target, which would just collide on the same
        // alreadyProcessed set and waste API quota.
        let activeQ = admin
          .from('tg_scan_jobs')
          .select('id, status')
          .eq('tg_chat_id', chatId)
          .in('status', ['pending', 'running']);
        if (topicId == null) {
          activeQ = activeQ.is('topic_id', null);
        } else {
          activeQ = activeQ.eq('topic_id', topicId);
        }
        const { data: active } = await activeQ.limit(1).maybeSingle();

        if (active) {
          return NextResponse.json(
            {
              error: 'Этот чат уже сканируется. Дождитесь завершения или остановите задачу.',
              jobId: active.id,
            },
            { status: 409 },
          );
        }

        const { data: job, error } = await admin
          .from('tg_scan_jobs')
          .insert({
            tg_chat_id: chatId,
            topic_id: topicId,
            video_count: videoCount,
            scan_mode: mode,
            user_id: user.id,
          })
          .select()
          .single();

        if (error || !job) {
          return jsonError(error?.message || 'Не удалось создать задачу', 500);
        }

        return NextResponse.json({ job });
    },
  );
}

/**
 * GET /api/tools/tg-transcribe/scan
 *
 * Returns:
 *   - `job`: the most relevant single scan job to render in the main panel.
 *     Priority: user's own active job → any other active job → user's recent
 *     finished job (within 5 minutes). null if nothing relevant.
 *   - `queue`: lightweight list of all OTHER currently-active scan jobs (excludes
 *     whichever job is in `job`). UI uses this to show "also running on chat X"
 *     so the user knows the worker is busy with someone else's scan too.
 */
export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-transcribe.scan.get' },
    async () => {
        const user = await getUser(req);
        if (!user) return jsonError('Необходима авторизация', 401);

        const JOB_COLS =
          'id,tg_chat_id,topic_id,video_count,scan_mode,status,scanned,videos_found,completed,errors,videos,error_message,created_at,updated_at,started_at,finished_at,user_id' as const;

        // Prefer user's own job — they should see their own scan, even if someone
        // else's started earlier. This way the "Сканировать"/"Остановить" controls
        // and progress always reflect what THIS user kicked off.
        const { data: ownActive } = await admin
          .from('tg_scan_jobs')
          .select(JOB_COLS)
          .eq('user_id', user.id)
          .in('status', ['pending', 'running'])
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        let primary = ownActive;
        if (!primary) {
          // Fallback: surface someone else's active scan so the user knows the
          // worker is busy and roughly what's running.
          const { data: anyActive } = await admin
            .from('tg_scan_jobs')
            .select(JOB_COLS)
            .in('status', ['pending', 'running'])
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          primary = anyActive;
        }

        const QUEUE_COLS =
          'id,tg_chat_id,topic_id,scan_mode,status,user_id,started_at,created_at' as const;
        const { data: queueRows } = await admin
          .from('tg_scan_jobs')
          .select(QUEUE_COLS)
          .in('status', ['pending', 'running'])
          .order('created_at', { ascending: true });

        type QueueRow = {
          id: string;
          tg_chat_id: number;
          topic_id: number | null;
          scan_mode: 'limited' | 'full' | null;
          status: 'pending' | 'running';
          user_id: string;
          started_at: string | null;
          created_at: string;
        };
        const queue = ((queueRows ?? []) as QueueRow[])
          .filter((r) => !primary || r.id !== primary.id)
          .map((r) => ({
            id: r.id,
            tg_chat_id: r.tg_chat_id,
            topic_id: r.topic_id,
            scan_mode: r.scan_mode ?? 'limited',
            status: r.status,
            isOwner: r.user_id === user.id,
            started_at: r.started_at,
            created_at: r.created_at,
          }));

        if (primary) {
          const { user_id: jobUserId, ...rest } = primary;
          return NextResponse.json({
            job: { ...rest, isOwner: jobUserId === user.id },
            queue,
          });
        }

        // Nothing active — return user's recently finished job for the "Готово / Ошибка"
        // banner. 5-minute window matches the page-reload recovery behaviour.
        const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const { data: recent } = await admin
          .from('tg_scan_jobs')
          .select(JOB_COLS)
          .eq('user_id', user.id)
          .in('status', ['completed', 'failed', 'stopped'])
          .gte('finished_at', fiveMinAgo)
          .order('finished_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (recent) {
          const { user_id: _uid, ...rest } = recent;
          return NextResponse.json({ job: { ...rest, isOwner: true }, queue });
        }

        return NextResponse.json({ job: null, queue });
    },
  );
}

/**
 * PATCH /api/tools/tg-transcribe/scan
 * Stop a running scan job. The worker checks `isStopped()` cooperatively.
 */
export async function PATCH(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-transcribe.scan.patch' },
    async () => {
        const user = await getUser(req);
        if (!user) return jsonError('Необходима авторизация', 401);

        let body: { jobId?: string };
        try {
          body = await req.json();
        } catch {
          return jsonError('Неверный JSON', 400);
        }

        if (!body.jobId) return jsonError('Необходим jobId', 400);

        const { data: job } = await admin
          .from('tg_scan_jobs')
          .select('id, status, user_id')
          .eq('id', body.jobId)
          .single();

        if (!job) return jsonError('Задача не найдена', 404);
        if (job.user_id !== user.id) return jsonError('Нет доступа', 403);
        if (!['pending', 'running'].includes(job.status)) {
          return jsonError('Задача уже завершена', 400);
        }

        await admin
          .from('tg_scan_jobs')
          .update({
            status: 'stopped',
            finished_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', body.jobId);

        return NextResponse.json({ ok: true });
    },
  );
}

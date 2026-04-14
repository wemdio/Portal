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
 */
export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-transcribe.scan.post' },
    async () => {
        const user = await getUser(req);
        if (!user) return jsonError('Необходима авторизация', 401);

        let body: { chatId?: number; videoCount?: number; topicId?: number | null };
        try {
          body = await req.json();
        } catch {
          return jsonError('Неверный JSON', 400);
        }

        const chatId = body.chatId;
        const videoCount = Math.min(Math.max(body.videoCount ?? 5, 1), 50);
        const topicId = body.topicId ?? null;

        if (!chatId) return jsonError('Необходим chatId', 400);

        // Block if any scan job is already running (globally)
        const { data: active } = await admin
          .from('tg_scan_jobs')
          .select('id, status')
          .in('status', ['pending', 'running'])
          .limit(1)
          .maybeSingle();

        if (active) {
          return NextResponse.json(
            { error: 'Уже запущена транскрибация. Дождитесь завершения.', jobId: active.id },
            { status: 409 },
          );
        }

        // Create job
        const { data: job, error } = await admin
          .from('tg_scan_jobs')
          .insert({
            tg_chat_id: chatId,
            topic_id: topicId,
            video_count: videoCount,
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
 * Returns the latest active or recently finished job for recovery on page load.
 */
export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-transcribe.scan.get' },
    async () => {
        const user = await getUser(req);
        if (!user) return jsonError('Необходима авторизация', 401);

        const JOB_COLS = 'id,tg_chat_id,topic_id,video_count,status,scanned,videos_found,completed,errors,videos,error_message,created_at,updated_at,finished_at,user_id' as const;

        // Return any active job (global, not just current user's)
        const { data: active } = await admin
          .from('tg_scan_jobs')
          .select(JOB_COLS)
          .in('status', ['pending', 'running'])
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (active) {
          const { user_id: jobUserId, ...rest } = active;
          return NextResponse.json({ job: { ...rest, isOwner: jobUserId === user.id } });
        }

        // Return the last finished job from current user (within 5 minutes)
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
          return NextResponse.json({ job: { ...rest, isOwner: true } });
        }

        return NextResponse.json({ job: null });
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

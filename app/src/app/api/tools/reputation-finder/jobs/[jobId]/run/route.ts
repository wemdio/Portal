import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { runReputationPipeline, type JobConfig } from '@/lib/reputationFinder/pipeline';
import { humanProgressStage } from '@/lib/reputationFinder/progressStages';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 900;

const POLL_INTERVAL_MS = 4_000;
const HEARTBEAT_INTERVAL_MS = 15_000;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const { jobId } = await params;

  const { data: job, error } = await supabase
    .from('reputation_jobs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (error || !job) return jsonError('Job not found', 404);
  if (job.status === 'running') return jsonError('Job already running', 409);
  if (job.status === 'completed') return jsonError('Job already completed', 409);
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const mode = job.mode as JobConfig['mode'];
  const config: JobConfig = {
    mode,
    ...(mode === 'local_reviews' ? { localReviews: job.config } : {}),
    ...(mode === 'brand_serp' ? { brandSerp: job.config } : {}),
    ...(mode === 'auto_search' ? { autoSearch: job.config } : {}),
  };

  void runReputationPipeline(jobId, config, () => {}, user.id).catch(() => {});

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let lastStage = '';
      let cancelled = false;

      function send(payload: Record<string, unknown>) {
        if (cancelled) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          cancelled = true;
        }
      }

      function heartbeat() {
        if (cancelled) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          cancelled = true;
        }
      }

      const hbTimer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);

      try {
        for (;;) {
          if (cancelled) break;
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          if (cancelled) break;

          const { data: row } = await supabaseAdmin!
            .from('reputation_jobs')
            .select('status, progress_stage, error_message, processed_candidates, total_candidates, auto_export_count, review_count, discard_count')
            .eq('id', jobId)
            .single();

          if (!row) {
            send({ error: 'Job not found' });
            break;
          }

          const stage = String(row.progress_stage ?? '');
          if (stage && stage !== lastStage) {
            lastStage = stage;
            const msg = humanProgressStage(stage);
            if (msg) send({ message: msg });
          }

          if (row.status === 'completed') {
            send({
              done: true,
              stats: {
                total: row.total_candidates ?? 0,
                autoExport: row.auto_export_count ?? 0,
                review: row.review_count ?? 0,
                discard: row.discard_count ?? 0,
              },
            });
            break;
          }

          if (row.status === 'failed') {
            send({ error: row.error_message ?? 'Pipeline failed' });
            break;
          }
        }
      } finally {
        clearInterval(hbTimer);
        if (!cancelled) {
          try { controller.close(); } catch { /* already closed */ }
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

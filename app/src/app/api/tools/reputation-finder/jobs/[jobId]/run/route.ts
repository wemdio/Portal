import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { runReputationPipeline, type JobConfig } from '@/lib/reputationFinder/pipeline';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 900;

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

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      function send(msg: string) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ message: msg })}\n\n`));
      }

      try {
        const mode = job.mode as JobConfig['mode'];
        const config: JobConfig = {
          mode,
          ...(mode === 'local_reviews' ? { localReviews: job.config } : {}),
          ...(mode === 'brand_serp' ? { brandSerp: job.config } : {}),
          ...(mode === 'auto_search' ? { autoSearch: job.config } : {}),
        };

        const stats = await runReputationPipeline(jobId, config, send, user.id);
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ done: true, stats })}\n\n`),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: message })}\n\n`),
        );
      } finally {
        controller.close();
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

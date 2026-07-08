import { NextResponse, type NextRequest } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/parsers/googleParsersRouteAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export type QueueStatusResponse = {
  activeJobId: string | null;
  queuedCount: number;
  averageJobDurationSec: number;
};

export async function GET(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (auth.error) return auth.error;

  if (!supabaseAdmin) return jsonError('Service unavailable', 503);

  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [activeResult, queuedResult, recentResult] = await Promise.all([
    supabaseAdmin
      .from('google_maps_jobs')
      .select('id')
      .eq('status', 'running')
      .order('started_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabaseAdmin
      .from('google_maps_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'queued'),
    supabaseAdmin
      .from('google_maps_jobs')
      .select('started_at,completed_at')
      .eq('status', 'completed')
      .not('started_at', 'is', null)
      .not('completed_at', 'is', null)
      .gte('completed_at', twentyFourHoursAgo),
  ]);

  if (activeResult.error) return jsonError(activeResult.error.message, 500);
  if (queuedResult.error) return jsonError(queuedResult.error.message, 500);
  if (recentResult.error) return jsonError(recentResult.error.message, 500);

  const durations = (recentResult.data ?? [])
    .map((r) => {
      if (!r.started_at || !r.completed_at) return null;
      const started = new Date(r.started_at).getTime();
      const completed = new Date(r.completed_at).getTime();
      const seconds = (completed - started) / 1000;
      return seconds > 0 && Number.isFinite(seconds) ? seconds : null;
    })
    .filter((n): n is number => n !== null);

  const averageJobDurationSec = durations.length
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : 0;

  const response: QueueStatusResponse = {
    activeJobId: activeResult.data?.id ?? null,
    queuedCount: queuedResult.count ?? 0,
    averageJobDurationSec,
  };

  return NextResponse.json(response);
}

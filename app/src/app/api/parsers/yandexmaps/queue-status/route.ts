import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export type QueueStatusResponse = {
  running_count: number;
  pending_count: number;
  capacity: number;
  free_slots: number;
  running_jobs: {
    progress_stage: string | null;
    processed_organizations: number;
    total_organizations: number;
    total_links: number;
    processed_links: number;
    started_at: string | null;
  }[];
};

/** Returns aggregate queue info (no user IDs exposed). Requires auth. */
export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { data: runningJobs, error: runningError } = await supabaseAdmin
    .from('yandex_maps_jobs')
    .select('progress_stage,processed_organizations,total_organizations,total_links,processed_links,started_at')
    .eq('status', 'running');

  if (runningError) return jsonError(runningError.message, 500);

  const { count: pendingCount, error: pendingError } = await supabaseAdmin
    .from('yandex_maps_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending');

  if (pendingError) return jsonError(pendingError.message, 500);

  const CAPACITY = 2;
  const runningCount = (runningJobs ?? []).length;

  const response: QueueStatusResponse = {
    running_count: runningCount,
    pending_count: pendingCount ?? 0,
    capacity: CAPACITY,
    free_slots: Math.max(0, CAPACITY - runningCount),
    running_jobs: (runningJobs ?? []).map((j) => ({
      progress_stage: j.progress_stage ?? null,
      processed_organizations: j.processed_organizations ?? 0,
      total_organizations: j.total_organizations ?? 0,
      total_links: j.total_links ?? 0,
      processed_links: j.processed_links ?? 0,
      started_at: j.started_at ?? null,
    })),
  };

  return NextResponse.json(response);
}

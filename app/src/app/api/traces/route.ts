import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * GET /api/traces
 *
 * Fetches recent traces (root spans + children) for the admin panel.
 * Query params:
 *   - limit: number of root traces to return (default 50)
 *   - job_id: filter by job_id
 *   - status: filter root spans by status
 */
export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  // Check admin role
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!profile || profile.role !== 'admin') {
    return jsonError('Forbidden', 403);
  }

  const url = req.nextUrl;
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? '50')));
  const jobId = url.searchParams.get('job_id');
  const statusFilter = url.searchParams.get('status');

  // 1) Fetch root spans (parent_span_id IS NULL) ordered by most recent
  let rootQuery = supabase
    .from('trace_spans')
    .select('*')
    .is('parent_span_id', null)
    .order('started_at', { ascending: false })
    .limit(limit);

  if (jobId) rootQuery = rootQuery.or(`job_id.eq.${jobId},search_job_id.eq.${jobId}`);
  if (statusFilter) rootQuery = rootQuery.eq('status', statusFilter);

  const { data: roots, error: rootsError } = await rootQuery;
  if (rootsError) return jsonError(rootsError.message, 500);
  if (!roots || roots.length === 0) {
    return NextResponse.json({ traces: [] });
  }

  // 2) Fetch all child spans for these traces
  const traceIds = roots.map((r) => r.trace_id);
  const { data: allSpans, error: spansError } = await supabase
    .from('trace_spans')
    .select('*')
    .in('trace_id', traceIds)
    .order('started_at', { ascending: true });

  if (spansError) return jsonError(spansError.message, 500);

  const requestIds = Array.from(
    new Set(
      roots
        .map((root) => {
          const input = root.input as Record<string, unknown> | null | undefined;
          const reqId = input?.requestId ?? input?.request_id;
          return typeof reqId === 'string' ? reqId : null;
        })
        .filter((id): id is string => Boolean(id)),
    ),
  );

  let logsByRequest = new Map<string, unknown[]>();
  if (requestIds.length > 0) {
    const { data: logs, error: logsError } = await supabase
      .from('application_logs')
      .select('*')
      .in('request_id', requestIds)
      .order('created_at', { ascending: true });

    if (logsError) return jsonError(logsError.message, 500);

    logsByRequest = new Map<string, unknown[]>();
    for (const entry of logs ?? []) {
      const requestId = (entry as { request_id?: string | null }).request_id;
      if (!requestId) continue;
      const bucket = logsByRequest.get(requestId) ?? [];
      bucket.push(entry);
      logsByRequest.set(requestId, bucket);
    }
  }

  const traceMap = new Map<string, typeof allSpans>();
  for (const span of allSpans ?? []) {
    const existing = traceMap.get(span.trace_id) ?? [];
    existing.push(span);
    traceMap.set(span.trace_id, existing);
  }

  const traces = roots.map((root) => ({
    trace_id: root.trace_id,
    root,
    spans: traceMap.get(root.trace_id) ?? [],
    logs: (() => {
      const input = root.input as Record<string, unknown> | null | undefined;
      const reqId = input?.requestId ?? input?.request_id;
      return typeof reqId === 'string' ? logsByRequest.get(reqId) ?? [] : [];
    })(),
  }));

  return NextResponse.json({ traces });
}

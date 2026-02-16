export type TraceSpanInsertPayload = {
  trace_id: string;
  parent_span_id: string | null;
  name: string;
  status: 'running';
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  started_at: string;
  user_id: string | null;
  job_id: string | null;
  search_job_id: string | null;
  level: 'info' | 'warn' | 'error';
  message: string | null;
};

export function buildTraceSpanInsertPayload(opts: {
  traceId: string;
  parentSpanId?: string | null;
  name: string;
  input?: Record<string, unknown>;
  message?: string;
  userId?: string | null;
  jobId?: string | null;
  searchJobId?: string | null;
  level?: 'info' | 'warn' | 'error';
  startedAt?: Date;
}): TraceSpanInsertPayload {
  const jobId = opts.jobId ?? null;
  const searchJobId = opts.searchJobId ?? null;
  if (jobId && searchJobId) {
    throw new Error('Provide either jobId or searchJobId, not both');
  }

  return {
    trace_id: opts.traceId,
    parent_span_id: opts.parentSpanId ?? null,
    name: opts.name,
    status: 'running',
    input: opts.input ?? {},
    output: {},
    started_at: (opts.startedAt ?? new Date()).toISOString(),
    user_id: opts.userId ?? null,
    job_id: jobId,
    search_job_id: searchJobId,
    level: opts.level ?? 'info',
    message: opts.message ?? null,
  };
}


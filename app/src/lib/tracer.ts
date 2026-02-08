import 'server-only';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export type SpanStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type SpanLevel = 'info' | 'warn' | 'error';

export type SpanInput = Record<string, unknown>;
export type SpanOutput = Record<string, unknown>;

export interface SpanRow {
  id: string;
  trace_id: string;
  parent_span_id: string | null;
  name: string;
  status: SpanStatus;
  input: SpanInput;
  output: SpanOutput;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  user_id: string | null;
  job_id: string | null;
  level: SpanLevel;
  message: string | null;
  created_at: string;
}

export interface CreateSpanOptions {
  name: string;
  traceId: string;
  parentSpanId?: string | null;
  input?: SpanInput;
  message?: string;
  userId?: string | null;
  jobId?: string | null;
  level?: SpanLevel;
}

/* -------------------------------------------------------------------------- */
/*  Low-level DB operations                                                   */
/* -------------------------------------------------------------------------- */

async function insertSpan(opts: CreateSpanOptions): Promise<string | null> {
  if (!supabaseAdmin) {
    console.error('[tracer] supabaseAdmin not configured');
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from('trace_spans')
    .insert({
      trace_id: opts.traceId,
      parent_span_id: opts.parentSpanId ?? null,
      name: opts.name,
      status: 'running' as SpanStatus,
      input: opts.input ?? {},
      output: {},
      started_at: new Date().toISOString(),
      user_id: opts.userId ?? null,
      job_id: opts.jobId ?? null,
      level: opts.level ?? 'info',
      message: opts.message ?? null,
    })
    .select('id')
    .single();

  if (error) {
    console.error('[tracer] Failed to insert span:', error);
    return null;
  }

  return data?.id ?? null;
}

async function updateSpan(
  spanId: string,
  patch: {
    status?: SpanStatus;
    output?: SpanOutput;
    level?: SpanLevel;
    message?: string;
    ended_at?: string;
    duration_ms?: number;
  },
): Promise<void> {
  if (!supabaseAdmin) return;

  const { error } = await supabaseAdmin
    .from('trace_spans')
    .update(patch)
    .eq('id', spanId);

  if (error) {
    console.error('[tracer] Failed to update span:', error);
  }
}

/* -------------------------------------------------------------------------- */
/*  Span handle                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A handle returned when a span is started. Use it to create child spans,
 * record output, and finish the span.
 */
export class Span {
  readonly id: string;
  readonly traceId: string;
  readonly name: string;
  private readonly _startedAt: number;
  private readonly _userId: string | null;
  private readonly _jobId: string | null;
  private _ended = false;

  constructor(opts: {
    id: string;
    traceId: string;
    name: string;
    startedAt: number;
    userId?: string | null;
    jobId?: string | null;
  }) {
    this.id = opts.id;
    this.traceId = opts.traceId;
    this.name = opts.name;
    this._startedAt = opts.startedAt;
    this._userId = opts.userId ?? null;
    this._jobId = opts.jobId ?? null;
  }

  /** Start a child span nested under this one. */
  async startChild(opts: {
    name: string;
    input?: SpanInput;
    message?: string;
    level?: SpanLevel;
  }): Promise<Span | null> {
    const startedAt = Date.now();
    const spanId = await insertSpan({
      name: opts.name,
      traceId: this.traceId,
      parentSpanId: this.id,
      input: opts.input,
      message: opts.message,
      userId: this._userId,
      jobId: this._jobId,
      level: opts.level,
    });
    if (!spanId) return null;

    return new Span({
      id: spanId,
      traceId: this.traceId,
      name: opts.name,
      startedAt,
      userId: this._userId,
      jobId: this._jobId,
    });
  }

  /** Mark span as completed with optional output data. */
  async end(output?: SpanOutput, message?: string): Promise<void> {
    if (this._ended) return;
    this._ended = true;
    const ended_at = new Date().toISOString();
    const duration_ms = Date.now() - this._startedAt;
    await updateSpan(this.id, {
      status: 'completed',
      output: output ?? {},
      ended_at,
      duration_ms,
      ...(message ? { message } : {}),
    });
  }

  /** Mark span as failed with error info. */
  async fail(error: unknown, output?: SpanOutput): Promise<void> {
    if (this._ended) return;
    this._ended = true;
    const ended_at = new Date().toISOString();
    const duration_ms = Date.now() - this._startedAt;

    const errorInfo = error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack?.slice(0, 2000) }
      : { message: typeof error === 'string' ? error : 'Unknown error' };

    await updateSpan(this.id, {
      status: 'failed',
      level: 'error',
      output: { ...errorInfo, ...(output ?? {}) },
      message: errorInfo.message,
      ended_at,
      duration_ms,
    });
  }

  /** Mark span as cancelled. */
  async cancel(message?: string): Promise<void> {
    if (this._ended) return;
    this._ended = true;
    const ended_at = new Date().toISOString();
    const duration_ms = Date.now() - this._startedAt;
    await updateSpan(this.id, {
      status: 'cancelled',
      level: 'warn',
      message: message ?? 'Cancelled',
      ended_at,
      duration_ms,
    });
  }

  /** Update output mid-flight (e.g. progress). */
  async setOutput(output: SpanOutput): Promise<void> {
    if (this._ended) return;
    await updateSpan(this.id, { output });
  }

  /** Update message mid-flight. */
  async setMessage(message: string): Promise<void> {
    if (this._ended) return;
    await updateSpan(this.id, { message });
  }
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Start a new root trace span. Returns a Span handle for further nesting.
 *
 * Usage:
 * ```ts
 * const root = await startTrace({
 *   name: 'hh.execute',
 *   input: { jobId, searchText },
 *   userId: user.id,
 *   jobId,
 * });
 *
 * const child = await root.startChild({ name: 'hh.fetch_vacancies', input: { ... } });
 * // ... work ...
 * await child.end({ found: 100 });
 *
 * await root.end({ totalParsed: 100 });
 * ```
 */
export async function startTrace(opts: {
  name: string;
  input?: SpanInput;
  message?: string;
  userId?: string | null;
  jobId?: string | null;
  level?: SpanLevel;
}): Promise<Span | null> {
  const traceId = crypto.randomUUID();
  const startedAt = Date.now();

  const spanId = await insertSpan({
    name: opts.name,
    traceId,
    parentSpanId: null,
    input: opts.input,
    message: opts.message,
    userId: opts.userId,
    jobId: opts.jobId,
    level: opts.level,
  });

  if (!spanId) return null;

  return new Span({
    id: spanId,
    traceId,
    name: opts.name,
    startedAt,
    userId: opts.userId,
    jobId: opts.jobId,
  });
}

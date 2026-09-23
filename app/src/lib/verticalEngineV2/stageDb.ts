import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Database access of a VE2 stage: every request is bounded and obeys the
 * job's abort signal, while the headers are awaited and while the body is read.
 *
 * Incident 23.09.2026: base_collect ticks went silent after database reads.
 * The shared admin client bounds a request only until the response headers
 * arrive; reading the body had neither a deadline nor the job's signal. Small
 * PostgREST responses are gzip-compressed by nginx and undici inflates them on
 * the libuv pool, so a body of a few dozen bytes waits for as long as that
 * pool is busy (e.g. getaddrinfo of dead website domains). The worker's
 * inactivity guard then aborted the job, the await ignored the abort, and
 * after 120 s the process exited, interrupting every other job — every ~22
 * minutes.
 *
 * Here the headers must arrive within the deadline and the body must keep
 * moving: a pause longer than the deadline between two chunks fails the read
 * (a slow but progressing 50-66 MB base row is not cut off). The body is
 * streamed through, never buffered a second time. The job's abort releases
 * the caller at once, whether or not the transport reacts to it.
 */

/** Wait for headers, and the longest pause between two body chunks. */
export const VE_STAGE_DB_TIMEOUT_MS = Math.max(1_000,
  Number(process.env.VE_STAGE_DB_TIMEOUT_MS ?? process.env.SUPABASE_FETCH_TIMEOUT_MS ?? '120000') || 120_000);

export class VeStageDbTimeoutError extends Error {
  readonly code = 'ETIMEDOUT';
  constructor(method: string, timeoutMs: number, phase: 'headers' | 'body') {
    super(`VE2 database ${method} request timeout after ${timeoutMs}ms (${phase === 'headers'
      ? 'no response headers' : 'response body stalled'})`);
    this.name = 'VeStageDbTimeoutError';
  }
}

/**
 * A stage request that timed out or lost its connection. The stage did not
 * fail by itself; the worker retries such a job without spending an attempt.
 * Stages usually rethrow `error.message` of the query with their own prefix,
 * so the marker is matched in the text.
 */
export function isVeStageDbInterruption(message: string): boolean {
  return /\bVE2 database [A-Z]+ request (?:timeout after|connection lost)\b/.test(message);
}

class VeStageDbConnectionError extends Error {
  readonly code: string | undefined;
  constructor(method: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const code = (cause as { code?: unknown; cause?: { code?: unknown } } | null)?.code
      ?? (cause as { cause?: { code?: unknown } } | null)?.cause?.code;
    super(`VE2 database ${method} request connection lost: ${detail}${typeof code === 'string' ? ` (${code})` : ''}`);
    this.name = 'VeStageDbConnectionError';
    this.code = typeof code === 'string' ? code : undefined;
  }
}

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

function abortReasonMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason ?? 'aborted');
}

/** postgrest-js rethrows AbortError without its own retries and turns it into `{ error }`. */
function jobAbortError(reason: unknown): Error {
  const error = new Error(`VE2 job aborted: ${abortReasonMessage(reason)}`);
  error.name = 'AbortError';
  return error;
}

/**
 * Links sources to one controller with plain listeners (removed after the
 * request): the long-lived job signal must not collect a listener per request.
 */
function linkSignals(controller: AbortController, sources: AbortSignal[]): () => void {
  const unlink: Array<() => void> = [];
  for (const source of sources) {
    if (source.aborted) { controller.abort(source.reason); break; }
    const onAbort = () => controller.abort(source.reason);
    source.addEventListener('abort', onAbort, { once: true });
    unlink.push(() => source.removeEventListener('abort', onAbort));
  }
  return () => { for (const remove of unlink) remove(); };
}

// ─── Diagnostics: what the job's database requests were doing ────────────────

interface VeStageDbRequestTrace {
  method: string;
  target: string;
  phase: 'headers' | 'body' | 'done' | 'failed';
  startedAt: number;
  phaseAt: number;
  status: number | null;
  bytes: number;
}

const jobRequests = new WeakMap<AbortSignal, { inFlight: Set<VeStageDbRequestTrace>; last: VeStageDbRequestTrace | null }>();

function requestTarget(input: RequestInfo | URL): string {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    const url = new URL(raw);
    const path = url.pathname.replace(/^\/rest\/v1\//, '');
    return `${path}${url.search ? `?${decodeURIComponent(url.search.slice(1))}` : ''}`.slice(0, 160);
  } catch { return raw.slice(0, 160); }
}

interface VeStageDbTraceHandle {
  phase: (status: number) => void;
  chunk: (bytes: number) => void;
  end: (failed: boolean) => void;
}

function traceRequest(job: AbortSignal | null, method: string, input: RequestInfo | URL): VeStageDbTraceHandle {
  if (!job) return { phase: () => {}, chunk: () => {}, end: () => {} };
  let state = jobRequests.get(job);
  if (!state) { state = { inFlight: new Set(), last: null }; jobRequests.set(job, state); }
  const now = Date.now();
  const trace: VeStageDbRequestTrace = { method, target: requestTarget(input), phase: 'headers', startedAt: now, phaseAt: now, status: null, bytes: 0 };
  const owner = state;
  owner.inFlight.add(trace);
  owner.last = trace;
  return {
    phase: (status: number) => { trace.phase = 'body'; trace.phaseAt = Date.now(); trace.status = status; },
    chunk: (bytes: number) => { trace.bytes += bytes; },
    end: (failed: boolean) => {
      if (!owner.inFlight.delete(trace)) return;
      trace.phase = failed ? 'failed' : 'done';
      trace.phaseAt = Date.now();
    },
  };
}

function describeTrace(trace: VeStageDbRequestTrace, now: number): string {
  const seconds = Math.round((now - trace.phaseAt) / 1000);
  const size = !trace.bytes ? '' : trace.bytes < 1024 ? `, ${trace.bytes} B`
    : trace.bytes < 1_048_576 ? `, ${(trace.bytes / 1024).toFixed(1)} KB` : `, ${(trace.bytes / 1_048_576).toFixed(2)} MB`;
  const what = trace.phase === 'headers' ? `waiting for headers ${seconds}s`
    : trace.phase === 'body' ? `reading body ${seconds}s (status ${trace.status}${size})`
      : `${trace.phase} ${seconds}s ago${size}`;
  return `${trace.method} ${trace.target} — ${what}`;
}

/** One line for the inactivity guard: the oldest request still open, else the last one. */
export function describeVeStageDbActivity(job: AbortSignal, now = Date.now()): string {
  const state = jobRequests.get(job);
  if (!state?.last) return 'no database requests';
  const open = [...state.inFlight].sort((a, b) => a.startedAt - b.startedAt);
  if (!open.length) return `last ${describeTrace(state.last, now)}`;
  return `${open.length} open, oldest ${describeTrace(open[0], now)}`;
}

// ─── Transport ────────────────────────────────────────────────────────────────

export function createVeStageFetch(options: {
  /** Signal of the job the current async context belongs to (null outside a job). */
  jobSignal: () => AbortSignal | null | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): typeof fetch {
  const timeoutMs = options.timeoutMs ?? VE_STAGE_DB_TIMEOUT_MS;
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const fetchImpl = options.fetchImpl ?? fetch;
    const method = (init?.method ?? 'GET').toUpperCase();
    const job = options.jobSignal() ?? null;
    if (job?.aborted) throw jobAbortError(job.reason);
    const trace = traceRequest(job, method, input);
    const request = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let phase: 'headers' | 'body' = 'headers';
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        request.abort(new VeStageDbTimeoutError(method, timeoutMs, phase));
      }, timeoutMs);
    };
    const unlink = linkSignals(request, [...(init?.signal ? [init.signal] : []), ...(job ? [job] : [])]);
    let released = false;
    const release = (failed: boolean) => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      unlink();
      trace.end(failed);
    };
    const failure = (error: unknown): unknown => {
      if (job?.aborted) return jobAbortError(job.reason);
      if (timedOut) return request.signal.reason;
      // The caller's own signal (e.g. a short hint lookup) keeps its error.
      if (init?.signal?.aborted || error instanceof VeStageDbConnectionError) return error;
      // Any other abort is the transport's own deadline (the admin fetch bounds headers too).
      const name = (error as { name?: unknown } | null)?.name;
      if (name === 'AbortError' || name === 'TimeoutError') return new VeStageDbTimeoutError(method, timeoutMs, phase);
      return new VeStageDbConnectionError(method, error);
    };

    arm();
    let response: Response;
    try {
      request.signal.throwIfAborted();
      // Released by the abort even when the transport never settles.
      response = await new Promise<Response>((resolve, reject) => {
        const onAbort = () => reject(request.signal.reason);
        request.signal.addEventListener('abort', onAbort, { once: true });
        fetchImpl(input, { ...init, signal: request.signal }).then((value) => {
          request.signal.removeEventListener('abort', onAbort);
          if (request.signal.aborted) { value.body?.cancel().catch(() => {}); return; }
          resolve(value);
        }, (error: unknown) => {
          request.signal.removeEventListener('abort', onAbort);
          reject(error);
        });
      });
    } catch (error) {
      release(true);
      throw failure(error);
    }
    trace.phase(response.status);
    phase = 'body';
    if (request.signal.aborted) {
      response.body?.cancel().catch(() => {});
      release(true);
      throw failure(request.signal.reason);
    }
    if (!response.body || NULL_BODY_STATUSES.has(response.status) || method === 'HEAD') {
      release(false);
      return response;
    }

    const reader = response.body.getReader();
    let output: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stop = (error: unknown) => {
      if (released) return;
      release(true);
      try { output?.error(error); } catch { /* already closed */ }
      reader.cancel(error).catch(() => {});
    };
    request.signal.addEventListener('abort', () => stop(failure(request.signal.reason)), { once: true });
    const body = new ReadableStream<Uint8Array>({
      start(controller) { output = controller; },
      async pull(controller) {
        if (released) return;
        arm();
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          stop(failure(error));
          return;
        }
        if (released) return;
        clearTimeout(timer);
        if (chunk.done) { release(false); controller.close(); return; }
        trace.chunk(chunk.value.byteLength);
        controller.enqueue(chunk.value);
      },
      cancel(reason) {
        release(false);
        return reader.cancel(reason);
      },
    });
    const headers = new Headers(response.headers);
    // The body is already decoded by the transport and may differ in length.
    headers.delete('content-encoding');
    headers.delete('content-length');
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
  };
}

/** One client for all stages: the job is taken from the async context of each request. */
export function createVeStageSupabase(options: {
  url: string;
  serviceRoleKey: string;
  jobSignal: () => AbortSignal | null | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): SupabaseClient {
  return createClient(options.url, options.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: createVeStageFetch(options) },
  });
}

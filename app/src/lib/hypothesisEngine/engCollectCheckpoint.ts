import { isDeepStrictEqual } from 'node:util';

import { heStageSignal } from './stages/io';
import type { HeStageContext } from './stages/shared';
import type { HeJob } from './types';

const READBACK_TIMEOUT_MS = 5_000;
const TRANSIENT_STATUS = new Set([408, 429, 502, 503, 504]);
const PERMANENT_CODE = /^(?:22|23|28|42|PGRST[123])|^(?:ABORT_ERR|ERR_CANCELED)$/i;
const PERMANENT_MESSAGE = /permission denied|unauthori[sz]ed|forbidden|invalid (?:api[ -]?key|jwt)|(?:jwt|token) (?:expired|invalid)|schema cache|violates (?:\w+\s+){0,3}constraint|invalid input syntax|(?:relation|column|function) .{0,150}does not exist/i;
const TRANSIENT_MESSAGE = /invalid response was received from the upstream server|the upstream server is (?:currently unavailable|timing out)|name resolution failed|failure to get a peer from the ring-balancer|\b(?:502 bad gateway|503 service (?:temporarily )?unavailable|504 gateway time-?out)\b|\b(?:ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|EPIPE|ENETUNREACH|UND_ERR_(?:CONNECT_TIMEOUT|SOCKET|HEADERS_TIMEOUT|BODY_TIMEOUT))\b|\bfetch failed\b/i;

/** This only admits a readback, never another write or a replay of paid work. */
function mayReadBack(error: unknown, status?: number): boolean {
  if (status !== undefined && status >= 400 && !TRANSIENT_STATUS.has(status)) return false;
  let transient = status !== undefined && TRANSIENT_STATUS.has(status);
  for (let current = error, depth = 0; current != null && depth < 4; depth += 1) {
    if (typeof current === 'string') {
      if (current.length > 4_096 || PERMANENT_MESSAGE.test(current)) return false;
      return transient || TRANSIENT_MESSAGE.test(current);
    }
    if (typeof current !== 'object') break;
    const item = current as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
    if (item.name === 'AbortError' || (typeof item.code === 'string' && PERMANENT_CODE.test(item.code))) return false;
    if (typeof item.message === 'string') {
      if (item.message.length > 4_096 || PERMANENT_MESSAGE.test(item.message)) return false;
      transient ||= TRANSIENT_MESSAGE.test(item.message);
    }
    if (typeof item.code === 'string') transient ||= TRANSIENT_MESSAGE.test(item.code);
    current = item.cause;
  }
  return transient;
}

export interface HeEngCollectCheckpointRecovery {
  ctx: HeStageContext;
  baseId: string;
  job: Pick<HeJob, 'id' | 'started_at'>;
  /** The immutable JSON-parsed payload captured BEFORE the failed UPDATE. */
  snapshot: unknown;
  error: unknown;
  status?: number;
}

/**
 * ENG opt-in only: a gateway error may have lost a successful UPDATE response.
 * Accept only a complete saved snapshot while the same job still owns the run.
 * No UPDATE retries: the base row has no atomic job-claim fence. False leaves
 * the original error with the caller; it does not authorize a stage replay.
 */
export async function recoverHeEngCollectCheckpoint(input: HeEngCollectCheckpointRecovery): Promise<boolean> {
  const { ctx, baseId, job, snapshot, error, status } = input;
  if (!mayReadBack(error, status) || !job.id || !baseId ||
      typeof job.started_at !== 'string' || !Number.isFinite(Date.parse(job.started_at)) ||
      !snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
  const jobId = job.id;
  const startedAt = job.started_at;
  const stageSignal = heStageSignal(ctx);
  if (stageSignal?.aborted) return false;

  const controller = new AbortController();
  const abort = () => controller.abort();
  stageSignal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, READBACK_TIMEOUT_MS);
  timer.unref?.();
  const signal = controller.signal;
  let stop: (() => void) | undefined;
  const interrupted = new Promise<false>(resolve => {
    stop = () => resolve(false);
    signal.addEventListener('abort', stop, { once: true });
  });

  const ownsJob = async (): Promise<boolean> => {
    if (signal.aborted) return false;
    const { data, error: readError } = await ctx.supabase.from('he_jobs')
      .select('status, started_at').eq('id', jobId).abortSignal(signal).maybeSingle();
    // Do not compare via Date.parse: distinct PostgreSQL microseconds can share
    // a JavaScript millisecond. A formatting mismatch safely declines recovery.
    return !signal.aborted && !readError && data?.status === 'running' && data.started_at === startedAt;
  };
  const readBack = async (): Promise<boolean> => {
    try {
      if (!(await ownsJob()) || signal.aborted) return false;
      const { data, error: readError } = await ctx.supabase.from('he_bases')
        .select('status, collect_info').eq('id', baseId).abortSignal(signal).maybeSingle();
      if (signal.aborted || readError || data?.status !== 'collecting' ||
          !isDeepStrictEqual(data.collect_info, snapshot)) return false;
      return await ownsJob();
    } catch {
      return false;
    }
  };
  try {
    const recovered = await Promise.race([readBack(), interrupted]);
    return recovered && !signal.aborted;
  } finally {
    clearTimeout(timer);
    stageSignal?.removeEventListener('abort', abort);
    if (stop) signal.removeEventListener('abort', stop);
  }
}

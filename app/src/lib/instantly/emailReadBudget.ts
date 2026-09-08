import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { InstantlyApiError } from './errors';

export type InstantlyEmailReadPriority = 'fresh' | 'recovery';
export type InstantlyEmailReadDeferredReason = 'budget' | 'cooldown' | 'storage_unavailable';

/** A technical deferral, never evidence that a reply is not a lead. */
export class InstantlyEmailReadDeferredError extends InstantlyApiError {
  constructor(
    public reason: InstantlyEmailReadDeferredReason,
    public retryAfterMs: number,
  ) {
    // Keep the prefix stable: older callers preserve only Error.message.
    super(`Instantly email read deferred: ${reason}; retry after ${Math.ceil(retryAfterMs)} ms`,
      reason === 'storage_unavailable' ? 503 : 429);
    this.name = 'InstantlyEmailReadDeferredError';
  }
}

const RPC_TIMEOUT_MS = 2500;
const STORAGE_RETRY_MS = 30_000;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
// Fences this process too if the provider's cooldown cannot be persisted. It is
// not a substitute for shared storage: reservations always go through Postgres.
const localCooldowns = new Map<string, number>();

function rpcTimeoutMs(deadline?: number): number {
  const remaining = deadline === undefined ? RPC_TIMEOUT_MS : deadline - Date.now();
  if (remaining <= 0) throw new InstantlyEmailReadDeferredError('budget', 1000);
  return Math.min(RPC_TIMEOUT_MS, remaining);
}

async function budgetRpc(
  name: 'instantly_reserve_email_read' | 'instantly_defer_email_reads',
  parameters: Record<string, string | number>,
  deadline?: number,
): Promise<unknown> {
  if (!supabaseAdmin) throw new InstantlyEmailReadDeferredError('storage_unavailable', STORAGE_RETRY_MS);
  const timeoutMs = rpcTimeoutMs(deadline);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new InstantlyEmailReadDeferredError('storage_unavailable', STORAGE_RETRY_MS));
      }, timeoutMs);
    });
    const result = await Promise.race([
      supabaseAdmin.rpc(name, parameters).abortSignal(controller.signal),
      timeout,
    ]);
    if (result.error) throw new InstantlyEmailReadDeferredError('storage_unavailable', STORAGE_RETRY_MS);
    return result.data as unknown;
  } catch (error) {
    if (error instanceof InstantlyEmailReadDeferredError) throw error;
    // No fail-open on missing migration, invalid RPC, timeout or DB outage.
    // Do not include raw database errors (which can contain connection details).
    throw new InstantlyEmailReadDeferredError('storage_unavailable', STORAGE_RETRY_MS);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One atomic reservation before EVERY HTTP attempt; never sleeps or bypasses. */
export async function reserveInstantlyEmailRead(
  accountId: string,
  priority: InstantlyEmailReadPriority = 'fresh',
  deadline?: number,
): Promise<void> {
  const localUntil = localCooldowns.get(accountId) ?? 0;
  if (localUntil > Date.now()) {
    throw new InstantlyEmailReadDeferredError('cooldown', localUntil - Date.now());
  }
  if (localUntil) localCooldowns.delete(accountId);
  const data = await budgetRpc('instantly_reserve_email_read', {
    p_account: accountId,
    p_priority: priority,
  }, deadline);
  if (!data || typeof data !== 'object') {
    throw new InstantlyEmailReadDeferredError('storage_unavailable', STORAGE_RETRY_MS);
  }
  const result = data as { granted?: unknown; retry_after_ms?: unknown; reason?: unknown };
  if (result.granted === true && result.retry_after_ms === 0) return;
  if (result.granted === false && typeof result.retry_after_ms === 'number' &&
      Number.isFinite(result.retry_after_ms) && result.retry_after_ms > 0 &&
      (result.reason === 'budget' || result.reason === 'cooldown')) {
    if (result.reason === 'cooldown') localCooldowns.set(accountId, Date.now() + result.retry_after_ms);
    throw new InstantlyEmailReadDeferredError(result.reason, result.retry_after_ms);
  }
  throw new InstantlyEmailReadDeferredError('storage_unavailable', STORAGE_RETRY_MS);
}

/** HTTP Retry-After supports delta-seconds or a date; fallback includes jitter. */
export function instantlyEmailRetryAfterMs(retryAfter: string | null | undefined, now = Date.now()): number {
  if (retryAfter?.trim()) {
    const value = retryAfter.trim();
    const seconds = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
    const parsed = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
    if (Number.isFinite(parsed) && parsed >= 0 && parsed < Number.MAX_SAFE_INTEGER) {
      return Math.max(1000, Math.ceil(parsed));
    }
  }
  return RATE_LIMIT_COOLDOWN_MS + Math.floor(Math.random() * 10_000);
}

/** Persists a workspace-wide 429 cooldown without retrying the provider call. */
export async function deferInstantlyEmailReads(
  accountId: string,
  retryAfterMs: number,
  deadline?: number,
): Promise<never> {
  localCooldowns.set(accountId, Math.max(localCooldowns.get(accountId) ?? 0, Date.now() + retryAfterMs));
  const data = await budgetRpc('instantly_defer_email_reads', {
    p_account: accountId,
    p_retry_after_ms: retryAfterMs,
  }, deadline);
  const result = data as { deferred?: unknown; retry_after_ms?: unknown } | null;
  if (!result || typeof result !== 'object' || result.deferred !== true ||
      typeof result.retry_after_ms !== 'number' || !Number.isFinite(result.retry_after_ms) ||
      result.retry_after_ms <= 0) {
    throw new InstantlyEmailReadDeferredError('storage_unavailable', STORAGE_RETRY_MS);
  }
  // Another process may have installed a longer cooldown before our RPC locked
  // the row. Do not send this caller back earlier than that shared deadline.
  const effectiveRetryMs = Math.max(retryAfterMs, result.retry_after_ms);
  localCooldowns.set(accountId, Math.max(localCooldowns.get(accountId) ?? 0, Date.now() + effectiveRetryMs));
  throw new InstantlyEmailReadDeferredError('cooldown', effectiveRetryMs);
}

import { createHash } from 'node:crypto';

const ORG_URL = 'https://api-v2.requesty.ai/v1/manage/org';
const SELF_URL = 'https://api-v2.requesty.ai/v1/manage/apikey/self';
const TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 32_768;

export interface VeRequestyCreditSignal {
  balanceUsd: number;
  monthlySpendUsd: number;
  /** Requesty uses zero for an unlimited monthly key budget. */
  monthlyLimitUsd: number;
}

interface VeRequestyKnownBalance extends VeRequestyCreditSignal {
  keyFingerprint: string;
  availableCreditUsd: number;
  creditSignal: VeRequestyCreditSignal;
}

type UnavailableReason = 'missing_api_key' | 'invalid_api_key' | 'authentication_failed'
  | 'management_forbidden' | 'rate_limited' | 'provider_unavailable' | 'http_error'
  | 'invalid_response' | 'response_too_large' | 'timeout' | 'aborted' | 'network_error'
  | 'group_budget_unknown';

export type VeRequestyBalanceResult =
  | (VeRequestyKnownBalance & { status: 'usable'; reason: 'credit_available' })
  | (VeRequestyKnownBalance & { status: 'blocked'; reason: 'insufficient_balance'
    | 'key_limit_reached' | 'completions_forbidden' })
  | { status: 'unavailable'; reason: UnavailableReason; keyFingerprint: string | null };

/** Keep the exact inference-key precedence; never substitute a management key. */
export function getVeRequestyApiKey(): string {
  const key = process.env.OPENROUTER_HYPOTHESIS_ENGINE_API_KEY || process.env.OPENROUTER_BRIEF_API_KEY;
  if (!key) {
    throw new Error('OPENROUTER_HYPOTHESIS_ENGINE_API_KEY не задан (и нет fallback OPENROUTER_BRIEF_API_KEY)');
  }
  return key;
}

/** A non-reversible identity for matching a billing failure to its exact key. */
export function veRequestyKeyFingerprint(apiKey: string): string {
  return createHash('sha256').update('ve2:requesty-key:v1\0').update(apiKey).digest('hex');
}

class BalanceProbeError extends Error {
  constructor(readonly reason: UnavailableReason) {
    super(reason);
    this.name = 'BalanceProbeError';
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function nonnegativeDecimal(value: unknown): number | null {
  // Live management responses also return decimal strings despite the numeric
  // OpenAPI schema. Do not coerce missing values, booleans, whitespace or hex.
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) value = Number(value);
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

async function managementJson(url: typeof ORG_URL | typeof SELF_URL, apiKey: string,
  fetchImpl: typeof fetch, signal: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method: 'GET', headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    redirect: 'error', cache: 'no-store', signal,
  });
  if (signal.aborted) { discardBody(response); throw new BalanceProbeError('aborted'); }
  if (!response.ok) {
    discardBody(response);
    const reason: UnavailableReason = response.status === 401 ? 'authentication_failed'
      : response.status === 403 ? 'management_forbidden'
        : response.status === 429 ? 'rate_limited'
          : response.status >= 500 ? 'provider_unavailable' : 'http_error';
    throw new BalanceProbeError(reason);
  }
  const length = response.headers.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > MAX_RESPONSE_BYTES) {
    discardBody(response);
    throw new BalanceProbeError('response_too_large');
  }
  if (!response.body) throw new BalanceProbeError('invalid_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let lengthRead = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new BalanceProbeError('aborted');
      if (done) break;
      lengthRead += value.byteLength;
      if (lengthRead > MAX_RESPONSE_BYTES) throw new BalanceProbeError('response_too_large');
      chunks.push(value);
    }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new BalanceProbeError('invalid_response'); }
    const data = record(body);
    if (!data) throw new BalanceProbeError('invalid_response');
    return data;
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
  }
}

/**
 * Read-only management checks with the same credential as inference. No model
 * probe, retry, alternative key, configurable origin, or response logging.
 *
 * `usable` is a billing signal, not proof that an arbitrary model call will
 * succeed. The caller must match keyFingerprint and require a genuine credit
 * improvement after another 402; ordinary balance/spend changes are not a new
 * recovery opportunity. Group budgets cannot be proven by org + self alone.
 */
export async function readVeRequestyBalance(options: {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
} = {}): Promise<VeRequestyBalanceResult> {
  let apiKey: string;
  try { apiKey = options.apiKey ?? getVeRequestyApiKey(); }
  catch { return { status: 'unavailable', reason: 'missing_api_key', keyFingerprint: null }; }
  if (!apiKey || apiKey.length > 4_096 || /\s/.test(apiKey)) {
    return { status: 'unavailable', reason: 'invalid_api_key', keyFingerprint: null };
  }
  const keyFingerprint = veRequestyKeyFingerprint(apiKey);
  const unavailable = (reason: UnavailableReason): VeRequestyBalanceResult =>
    ({ status: 'unavailable', reason, keyFingerprint });
  if (options.signal?.aborted) return unavailable('aborted');

  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
  let onStop: () => void = () => undefined;
  const stopped = new Promise<never>((_, reject) => {
    onStop = () => reject(new BalanceProbeError(timedOut ? 'timeout' : 'aborted'));
    controller.signal.addEventListener('abort', onStop, { once: true });
  });
  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const [org, key] = await Promise.race([
      Promise.all([
        managementJson(ORG_URL, apiKey, fetchImpl, controller.signal),
        managementJson(SELF_URL, apiKey, fetchImpl, controller.signal),
      ]), stopped,
    ]);
    const balanceUsd = nonnegativeDecimal(org.balance);
    const monthlySpendUsd = nonnegativeDecimal(key.monthly_spend);
    const monthlyLimitUsd = nonnegativeDecimal(key.monthly_limit);
    const permissions = record(key.permissions);
    if (balanceUsd === null || monthlySpendUsd === null || monthlyLimitUsd === null
      || typeof key.id !== 'string' || !key.id || key.id.length > 128
      || !permissions || typeof permissions.manage !== 'string'
      || !['none', 'read', 'write'].includes(permissions.manage)
      || typeof permissions.completions !== 'string'
      || !['none', 'read', 'write'].includes(permissions.completions)) {
      return unavailable('invalid_response');
    }
    if (key.group != null) return unavailable('group_budget_unknown');
    const creditSignal = { balanceUsd, monthlySpendUsd, monthlyLimitUsd };
    const snapshot: VeRequestyKnownBalance = { ...creditSignal, keyFingerprint, creditSignal,
      availableCreditUsd: Math.max(0, Math.min(balanceUsd,
        monthlyLimitUsd === 0 ? balanceUsd : monthlyLimitUsd - monthlySpendUsd)) };
    if (permissions.completions !== 'write') {
      return { ...snapshot, status: 'blocked', reason: 'completions_forbidden' };
    }
    if (balanceUsd <= 0) return { ...snapshot, status: 'blocked', reason: 'insufficient_balance' };
    if (monthlyLimitUsd > 0 && monthlySpendUsd >= monthlyLimitUsd) {
      return { ...snapshot, status: 'blocked', reason: 'key_limit_reached' };
    }
    return { ...snapshot, status: 'usable', reason: 'credit_available' };
  } catch (error) {
    return unavailable(timedOut ? 'timeout' : options.signal?.aborted ? 'aborted'
      : error instanceof BalanceProbeError ? error.reason : 'network_error');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    controller.signal.removeEventListener('abort', onStop);
    controller.abort();
  }
}

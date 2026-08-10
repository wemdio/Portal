import 'server-only';

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

const DEFAULT_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 300;
const DEFAULT_MAX_DELAY_MS = 5000;

const TRANSIENT_CODES = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ECONNRESET',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const TRANSIENT_HTTP_STATUSES = new Set([502, 503, 504, 520, 522, 524]);

export function isTransientError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const retryable = err as { message?: unknown; code?: unknown; status?: unknown };
  const message = String(retryable.message ?? '');
  const code = String(retryable.code ?? '').toUpperCase();
  const status = Number(retryable.status);

  return (
    TRANSIENT_CODES.has(code) ||
    TRANSIENT_HTTP_STATUSES.has(status) ||
    /\b(?:502|503|504|520|522|524)\b|abort|tim(?:ed|ing)?\s*out|timeout|fetch failed|socket hang up|econnreset|epipe|eai_again|enetunreach|network|service unavailable/i.test(
      message,
    )
  );
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const retries = options?.retries ?? DEFAULT_RETRIES;
  const baseDelay = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelay = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < retries && isTransientError(err)) {
        const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

import 'server-only';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DB_FETCH_TIMEOUT_MS = Number(process.env.SUPABASE_FETCH_TIMEOUT_MS ?? '120000');
const DB_RETRY_MAX_ATTEMPTS = Math.max(1, Number(process.env.SUPABASE_RETRY_MAX_ATTEMPTS ?? '3'));
const DB_RETRY_BASE_DELAY_MS = Math.max(50, Number(process.env.SUPABASE_RETRY_BASE_DELAY_MS ?? '500'));

function isValidHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// Errors that prove the request never reached the server, so retrying
// non-idempotent methods (POST/PATCH/DELETE) is safe — no risk of a duplicate write.
const SAFE_TO_RETRY_NON_GET_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
]);

// Mid-stream / post-send errors: safe to retry only for idempotent GET, since
// the server may have already applied the write before the connection broke.
const RETRY_GET_CODES = new Set([
  ...SAFE_TO_RETRY_NON_GET_CODES,
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

interface ErrorWithCause {
  cause?: unknown;
  code?: string;
}

function extractErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as ErrorWithCause;
  if (typeof e.code === 'string') return e.code;
  if (e.cause && typeof e.cause === 'object') {
    const cause = e.cause as ErrorWithCause;
    if (typeof cause.code === 'string') return cause.code;
  }
  return undefined;
}

function shouldRetry(err: unknown, method: string): boolean {
  const code = extractErrorCode(err);
  if (!code) return false;
  if (method === 'GET' || method === 'HEAD') {
    return RETRY_GET_CODES.has(code);
  }
  // For writes, retry only if we know the request never landed
  return SAFE_TO_RETRY_NON_GET_CODES.has(code);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchOnce(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DB_FETCH_TIMEOUT_MS);
  let signal: AbortSignal = controller.signal;
  if (init?.signal) {
    if (typeof AbortSignal.any === 'function') {
      signal = AbortSignal.any([init.signal, controller.signal]);
    } else {
      init.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }
  return fetch(url, { ...init, signal }).finally(() => clearTimeout(timer));
}

async function fetchWithRetry(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = (init?.method || 'GET').toUpperCase();
  let lastError: unknown;

  for (let attempt = 1; attempt <= DB_RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await fetchOnce(url, init);
    } catch (err) {
      // User aborted via their own signal — never retry.
      if (init?.signal?.aborted) throw err;

      lastError = err;
      const canRetry = attempt < DB_RETRY_MAX_ATTEMPTS && shouldRetry(err, method);
      if (!canRetry) throw err;

      const backoffMs = DB_RETRY_BASE_DELAY_MS * Math.pow(3, attempt - 1);
      const code = extractErrorCode(err) ?? 'unknown';
      // Single-line warn so log scraping (health-check) can count occurrences.
      console.warn(
        `[supabaseAdmin] retry ${attempt}/${DB_RETRY_MAX_ATTEMPTS - 1} ` +
        `${method} after ${backoffMs}ms (code=${code})`,
      );
      await sleep(backoffMs);
    }
  }

  throw lastError;
}

export const supabaseAdmin = isValidHttpUrl(supabaseUrl) && supabaseServiceRoleKey
  ? createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: fetchWithRetry },
    })
  : null;

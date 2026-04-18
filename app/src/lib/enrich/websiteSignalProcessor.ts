import { fetchHtmlWithRetry, fetchHtmlWithPlaywright } from '@/lib/enrich/websiteParser';
import { normalizeUrl } from '@/lib/enrich/urlUtils';
import { detectSignals, determineProfile, formatStack } from '@/lib/enrich/signalDetector';

const DEFAULT_TIMEOUT_MS = 12_000;
const PLAYWRIGHT_TIMEOUT_MS = 18_000;

export type ProcessSignalsResult =
  | {
      stack: string;
      profile: string;
      signalIds: string[];
      method: 'http' | 'playwright';
    }
  | { error: string };

export interface ProcessSignalsOptions {
  timeout?: number;
  signal?: AbortSignal;
}

const ERROR_PATTERNS: Array<[RegExp, string]> = [
  [/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i, 'Домен не найден (DNS не резолвится)'],
  [/ERR_CONNECTION_REFUSED|ECONNREFUSED/i, 'Сервер отклонил соединение'],
  [/ERR_CONNECTION_TIMED_OUT|ETIMEDOUT|[Tt]imeout/i, 'Таймаут подключения'],
  [/ERR_CERT|ERR_SSL|certificate/i, 'Ошибка SSL-сертификата'],
  [/ERR_CONNECTION_RESET|ECONNRESET/i, 'Соединение сброшено'],
  [/ERR_TOO_MANY_REDIRECTS/i, 'Слишком много редиректов'],
];

/**
 * Classify raw HTTP / Playwright error messages into a short, user-facing
 * Russian string. Falls back to "Сайт недоступен" when no known pattern
 * matches.
 */
function classifyFetchError(httpErr: unknown, pwErr: unknown): string {
  const messages = [httpErr, pwErr]
    .filter(Boolean)
    .map((e) => (e instanceof Error ? e.message : String(e)));

  const combined = messages.join(' ');
  if (!combined) return 'Сайт недоступен';

  for (const [pattern, label] of ERROR_PATTERNS) {
    if (pattern.test(combined)) return label;
  }

  return 'Сайт недоступен';
}

/**
 * Fetch a website's HTML and detect signals (tech stack + business profile).
 *
 * Tries HTTP first (fast, cheap). If HTTP returns null, non-2xx, or throws,
 * falls back to Playwright (slow, requires Chromium binary in worker container).
 *
 * Pure-ish function — only side effects are network calls. Designed to be
 * called from a worker (where Playwright is available) — see Dockerfile.worker.
 */
export async function processSignalsForUrl(
  rawUrl: string,
  options?: ProcessSignalsOptions,
): Promise<ProcessSignalsResult> {
  const trimmed = String(rawUrl ?? '').trim();
  if (!trimmed) return { error: 'Пустой URL' };

  let normalized: string;
  try {
    normalized = normalizeUrl(trimmed);
    if (!normalized) throw new Error('Невалидный URL');
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Невалидный URL' };
  }

  const httpTimeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
  const signal = options?.signal;

  let html: string | null = null;
  let method: 'http' | 'playwright' = 'http';
  let httpError: unknown = null;
  let pwError: unknown = null;

  try {
    const httpResult = await fetchHtmlWithRetry(normalized, {
      timeout: httpTimeout,
      signal,
      allowHttpErrors: false,
    });
    if (httpResult && httpResult.status >= 200 && httpResult.status < 300 && httpResult.html) {
      html = httpResult.html;
    }
  } catch (err) {
    httpError = err;
    html = null;
  }

  if (!html && !signal?.aborted) {
    try {
      const pwHtml = await fetchHtmlWithPlaywright(normalized, {
        timeout: PLAYWRIGHT_TIMEOUT_MS,
        signal,
      });
      if (pwHtml && pwHtml.length > 120) {
        html = pwHtml;
        method = 'playwright';
      }
    } catch (err) {
      pwError = err;
      html = null;
    }
  }

  if (!html) {
    return { error: classifyFetchError(httpError, pwError) };
  }

  const signals = detectSignals(html);
  const profile = determineProfile(signals);
  const stack = formatStack(signals);

  return {
    stack,
    profile,
    signalIds: signals.map((s) => s.id),
    method,
  };
}

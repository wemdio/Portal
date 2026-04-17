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

  try {
    const httpResult = await fetchHtmlWithRetry(normalized, {
      timeout: httpTimeout,
      signal,
      allowHttpErrors: false,
    });
    if (httpResult && httpResult.status >= 200 && httpResult.status < 300 && httpResult.html) {
      html = httpResult.html;
    }
  } catch {
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
    } catch {
      html = null;
    }
  }

  if (!html) {
    return { error: 'Не удалось загрузить сайт (HTTP и Playwright недоступны)' };
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

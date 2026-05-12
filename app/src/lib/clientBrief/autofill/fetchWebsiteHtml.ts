/**
 * Fetches the homepage HTML of a customer website with conservative limits.
 *
 * - Normalizes bare domains to https://.
 * - Adds a timeout via AbortController.
 * - Caps response body size to avoid runaway downloads.
 * - Refuses non-HTTP(S) URLs.
 * - Never throws on slow/unreachable hosts — wraps them in a typed error.
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 1_500_000; // ≈ 1.5 MB of HTML is plenty.
const USER_AGENT =
  'PortalBriefAutofill/1.0 (+contact via portal client brief autofill)';

export interface FetchWebsiteHtmlOptions {
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
}

export interface FetchWebsiteHtmlResult {
  url: string;
  html: string;
}

export class WebsiteFetchError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = 'WebsiteFetchError';
    this.status = status;
  }
}

export function normalizeWebsiteUrl(input: string): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  let withScheme = trimmed;
  if (!/^https?:\/\//i.test(withScheme)) {
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(withScheme)) {
      withScheme = `https://${withScheme}`;
    } else {
      return null;
    }
  }

  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

export async function fetchWebsiteHtml(
  website: string,
  options: FetchWebsiteHtmlOptions = {},
): Promise<FetchWebsiteHtmlResult> {
  const url = normalizeWebsiteUrl(website);
  if (!url) {
    throw new WebsiteFetchError('Невалидный URL сайта', 400);
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const fetchImpl = options.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'ru,en;q=0.8',
      },
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new WebsiteFetchError(`Сайт не ответил за ${Math.round(timeoutMs / 1000)} с`, 504);
    }
    const message = err instanceof Error ? err.message : 'Network error';
    throw new WebsiteFetchError(`Не удалось загрузить сайт: ${message}`, 502);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new WebsiteFetchError(
      `Сайт вернул HTTP ${response.status}. Проверьте URL и доступность.`,
      502,
    );
  }

  let html: string;
  try {
    const text = await response.text();
    html = text.length > maxBytes ? text.slice(0, maxBytes) : text;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Read error';
    throw new WebsiteFetchError(`Не удалось прочитать ответ сайта: ${message}`, 502);
  }

  return { url, html };
}

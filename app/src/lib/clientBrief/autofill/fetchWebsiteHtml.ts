/**
 * Fetches the homepage HTML of a customer website with conservative limits.
 *
 * - Normalizes bare domains to https://.
 * - Adds a timeout via AbortController.
 * - Caps response body size to avoid runaway downloads.
 * - Refuses non-HTTP(S) URLs.
 * - Never throws on slow/unreachable hosts — wraps them in a typed error.
 * - Falls back https→http when HTTPS fails at the network level (часть
 *   RU-сайтов не слушает 443, но нормально отвечает на 80-м порту).
 * - Проходит антибот-заглушку Beget (JS cookie + location.reload) — cookie
 *   извлекается из заглушки и запрос повторяется с ней.
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
  /** true, если не удалось получить вообще никакого HTTP-ответа (таймаут,
   *  connection refused, TLS-ошибка) — в отличие от ответа с ошибочным статусом. */
  readonly networkFailure: boolean;
  constructor(message: string, status = 502, networkFailure = false) {
    super(message);
    this.name = 'WebsiteFetchError';
    this.status = status;
    this.networkFailure = networkFailure;
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

/**
 * Антибот-заглушка хостера Beget: сервер отдаёт 200 OK с крошечным JS,
 * который ставит cookie (`document.cookie='beget=begetok'`) и делает
 * location.reload(). Без cookie дальше заглушки не пройти; имя/значение
 * cookie указаны прямо в теле заглушки — извлекаем и повторяем запрос с ней.
 */
const BEGET_COOKIE_RE = /document\.cookie\s*=\s*'([A-Za-z0-9_]+=[A-Za-z0-9_]+)'/;

function extractBegetChallengeCookie(html: string): string | null {
  const head = html.slice(0, 3_000);
  if (!head.includes('location.reload')) return null;
  const match = BEGET_COOKIE_RE.exec(head);
  return match ? match[1] : null;
}

interface FetchOnceOptions {
  timeoutMs: number;
  maxBytes: number;
  fetchImpl: typeof fetch;
  /** Если задана — ведём редиректы вручную: fetch-спека срезает вручную
   *  выставленную Cookie на кросс-origin редиректах (http→https = другой
   *  origin), а Beget отвечает 301 на https после прохождения проверки. */
  cookie?: string;
}

async function fetchOnce(
  startUrl: string,
  options: FetchOnceOptions,
): Promise<FetchWebsiteHtmlResult> {
  const { timeoutMs, maxBytes, fetchImpl, cookie } = options;
  const maxRedirects = 5;
  let currentUrl = startUrl;

  for (let redirectCount = 0; ; redirectCount += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(currentUrl, {
        method: 'GET',
        redirect: cookie ? 'manual' : 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'ru,en;q=0.8',
          ...(cookie ? { Cookie: cookie } : {}),
        },
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new WebsiteFetchError(
          `Сайт не ответил за ${Math.round(timeoutMs / 1000)} с`,
          504,
          true,
        );
      }
      const message = err instanceof Error ? err.message : 'Network error';
      throw new WebsiteFetchError(`Не удалось загрузить сайт: ${message}`, 502, true);
    } finally {
      clearTimeout(timeoutId);
    }

    if (cookie && response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location && redirectCount < maxRedirects) {
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
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

    return { url: currentUrl, html };
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

  let result: FetchWebsiteHtmlResult;
  try {
    result = await fetchOnce(url, { timeoutMs, maxBytes, fetchImpl });
  } catch (err) {
    // У части RU-сайтов малого бизнеса HTTPS недоступен на сетевом уровне
    // (порт 443 фильтруется/не слушает — у Beget, например, пока посетитель
    // не пройдёт антибот-проверку на 80-м порту). Если HTTPS не дал вообще
    // никакого ответа — пробуем plain HTTP. Ответ с ошибочным статусом
    // (403/500/...) фолбэка НЕ вызывает: сервер жив и ответил осмысленно.
    if (err instanceof WebsiteFetchError && err.networkFailure && url.startsWith('https://')) {
      result = await fetchOnce(url.replace(/^https:\/\//i, 'http://'), {
        timeoutMs,
        maxBytes,
        fetchImpl,
      });
    } else {
      throw err;
    }
  }

  // Антибот-заглушка Beget — проходим её cookie и повторяем запрос.
  const challengeCookie = extractBegetChallengeCookie(result.html);
  if (challengeCookie) {
    result = await fetchOnce(result.url, {
      timeoutMs,
      maxBytes,
      fetchImpl,
      cookie: challengeCookie,
    });
    if (extractBegetChallengeCookie(result.html)) {
      throw new WebsiteFetchError(
        'Сайт защищён антибот-проверкой хостера (Beget) — не удалось пройти её автоматически. ' +
          'Попробуйте позже или заполните бриф вручную.',
        502,
      );
    }
  }

  return result;
}

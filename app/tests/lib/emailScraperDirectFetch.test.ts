/**
 * @jest-environment node
 *
 * Regression for the 2026-07-30 base-constructor slowdown. PROXY_URLS is used
 * by other parsers, but email discovery must fetch sites directly: slow/dead
 * shared proxies used to consume the page timeout before a direct fallback.
 *
 * С 21.09.2026 dispatcher всё же есть — undici.Agent с выключенной проверкой
 * сертификата (RU-промсайты массово живут на невалидируемых цепочках). Прокси
 * в нём по-прежнему нет, и проверяем мы именно это.
 */

import { scrapeEmails } from '@/lib/enrich/emailScraper';

describe('emailScraper direct fetching', () => {
  const originalFetch = global.fetch;
  const originalProxyUrls = process.env.PROXY_URLS;

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalProxyUrls === undefined) delete process.env.PROXY_URLS;
    else process.env.PROXY_URLS = originalProxyUrls;
  });

  it('does not route through a proxy even when PROXY_URLS is configured', async () => {
    process.env.PROXY_URLS = 'http://user:pass@slow-proxy.invalid:8000';
    const fetchMock = jest.fn(async (_url: unknown, _init?: RequestInit) => {
      return new Response('<html><body>sales@acme.ru</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await scrapeEmails('https://acme.ru', {
      timeout: 1_000,
      maxPages: 1,
      stopAtFirstUsableEmail: true,
    });

    expect(result.emails).toEqual(['sales@acme.ru']);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const init = fetchMock.mock.calls[0][1] as { dispatcher?: unknown } | undefined;
    const dispatcher = init?.dispatcher as Record<symbol, unknown> | undefined;
    expect(dispatcher).toBeDefined();
    const options = Object.getOwnPropertySymbols(dispatcher ?? {})
      .filter((sym) => sym.description === 'options')
      .map((sym) => (dispatcher as Record<symbol, unknown>)[sym])[0] as
        | { connect?: { rejectUnauthorized?: boolean }; uri?: string; proxy?: unknown }
        | undefined;
    // Это TLS-агент, а не ProxyAgent: proxy-полей нет, проверка сертификата снята.
    expect(options?.connect?.rejectUnauthorized).toBe(false);
    expect(options?.uri).toBeUndefined();
    expect(options?.proxy).toBeUndefined();
    expect(JSON.stringify(options ?? {})).not.toContain('slow-proxy.invalid');
  });

  it('reports why the page could not be read instead of returning silence', async () => {
    const tlsError = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'CERT_HAS_EXPIRED' },
    });
    global.fetch = jest.fn(async () => {
      throw tlsError;
    }) as unknown as typeof fetch;

    const result = await scrapeEmails('https://expired.ru', { timeout: 500, maxPages: 1 });

    expect(result.emails).toEqual([]);
    expect(result.failureReason).toBe('Сертификат сайта не прошёл проверку');
  });

  it('leaves failureReason empty when the site opened and simply has no email', async () => {
    global.fetch = jest.fn(async () => new Response('<html><body>нет почты</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })) as unknown as typeof fetch;

    const result = await scrapeEmails('https://empty.ru', { timeout: 500, maxPages: 1 });

    expect(result.emails).toEqual([]);
    expect(result.failureReason).toBeNull();
  });
});

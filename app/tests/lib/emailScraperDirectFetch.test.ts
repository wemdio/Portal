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

describe('emailScraper proxy retry on bot protection', () => {
  const originalFetch = global.fetch;
  const originalPriority = process.env.YANDEXMAPS_PROXY_URLS_PRIORITY;

  beforeEach(() => {
    process.env.YANDEXMAPS_PROXY_URLS_PRIORITY = '["http://user:pass@ru-proxy.invalid:8000"]';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('@/lib/enrich/proxyPool').resetProxyGroupsCache();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalPriority === undefined) delete process.env.YANDEXMAPS_PROXY_URLS_PRIORITY;
    else process.env.YANDEXMAPS_PROXY_URLS_PRIORITY = originalPriority;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('@/lib/enrich/proxyPool').resetProxyGroupsCache();
  });

  const htmlResponse = (body: string) =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

  it('retries a 403 main page through the proxy and keeps the address it finds', async () => {
    const calls: Array<{ hasProxy: boolean }> = [];
    global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
      const dispatcher = (init as { dispatcher?: { constructor?: { name?: string } } })?.dispatcher;
      const hasProxy = dispatcher?.constructor?.name === 'ProxyAgent';
      calls.push({ hasProxy });
      if (!hasProxy) return new Response('nope', { status: 403 });
      return htmlResponse('<html><body>sales@blocked.ru</body></html>');
    }) as unknown as typeof fetch;

    const result = await scrapeEmails('https://blocked.ru', {
      timeout: 1_000,
      maxPages: 1,
      stopAtFirstUsableEmail: true,
    });

    expect(result.emails).toEqual(['sales@blocked.ru']);
    expect(result.failureReason).toBeNull();
    expect(calls.some((c) => c.hasProxy)).toBe(true);
  });

  it('does not spend a proxy request on a timeout — only bot protection is retried', async () => {
    let proxyCalls = 0;
    global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
      const dispatcher = (init as { dispatcher?: { constructor?: { name?: string } } })?.dispatcher;
      if (dispatcher?.constructor?.name === 'ProxyAgent') proxyCalls += 1;
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
    }) as unknown as typeof fetch;

    const result = await scrapeEmails('https://slow.ru', { timeout: 500, maxPages: 1 });

    expect(proxyCalls).toBe(0);
    expect(result.failureReason).toBe('Сайт не ответил за отведённое время');
  });

  it('honours the kill switch', async () => {
    const prev = process.env.EMAIL_SCRAPER_PROXY_RETRY;
    process.env.EMAIL_SCRAPER_PROXY_RETRY = '0';
    jest.resetModules();
    try {
      let proxyCalls = 0;
      global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
        const dispatcher = (init as { dispatcher?: { constructor?: { name?: string } } })?.dispatcher;
        if (dispatcher?.constructor?.name === 'ProxyAgent') proxyCalls += 1;
        return new Response('nope', { status: 403 });
      }) as unknown as typeof fetch;

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { scrapeEmails: fresh } = require('@/lib/enrich/emailScraper');
      const result = await fresh('https://blocked.ru', { timeout: 500, maxPages: 1 });

      expect(proxyCalls).toBe(0);
      expect(result.failureReason).toBe('Сайт блокирует автоматические запросы (403)');
    } finally {
      if (prev === undefined) delete process.env.EMAIL_SCRAPER_PROXY_RETRY;
      else process.env.EMAIL_SCRAPER_PROXY_RETRY = prev;
      jest.resetModules();
    }
  });
});

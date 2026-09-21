/**
 * @jest-environment node
 *
 * Regression for the 2026-07-30 base-constructor slowdown. PROXY_URLS is used
 * by other parsers, but email discovery must fetch sites directly: slow/dead
 * shared proxies used to consume the page timeout before a direct fallback.
 *
 * С 21.09.2026 dispatcher всё же есть — undici.Agent с выключенной проверкой
 * сертификата. Прокси в нём по-прежнему нет, и проверяем мы именно это.
 */

import { scrapeEmails } from '@/lib/enrich/emailScraper';
import { reusableMainPageDescription } from '@/lib/enrich/websiteParser';

describe('emailScraper direct fetching', () => {
  const originalFetch = global.fetch;
  const originalProxyUrls = process.env.PROXY_URLS;

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
    if (originalProxyUrls === undefined) delete process.env.PROXY_URLS;
    else process.env.PROXY_URLS = originalProxyUrls;
  });

  it('does not attach a proxy dispatcher even when PROXY_URLS is configured', async () => {
    jest.useFakeTimers();
    process.env.PROXY_URLS = 'http://user:pass@slow-proxy.invalid:8000';
    const fetchMock = jest.fn(async (_url: unknown, _init?: RequestInit) => {
      return new Response(`<html><body><p>${'We manufacture medical equipment for private clinics. '.repeat(8)}</p>sales@acme.ru</body></html>`, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await scrapeEmails('https://acme.ru', {
      timeout: 1_000,
      maxPages: 1,
      stopAtFirstUsableEmail: true,
      includeDescription: true,
    });

    expect(result.emails).toEqual(['sales@acme.ru']);
    expect(result.description).toContain('manufacture medical equipment');
    expect(reusableMainPageDescription('<html><body>Contact us</body></html>')).toBe('');
    expect(reusableMainPageDescription('<html><script>' + 'business '.repeat(100) + '</script><body>Hi</body></html>')).toBe('');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // С 21.09.2026 dispatcher есть всегда — undici.Agent со снятой проверкой
    // сертификата (RU-промсайты массово живут на невалидируемых цепочках).
    // Проверяем, что это именно он, а не ProxyAgent из PROXY_URLS.
    const init = fetchMock.mock.calls[0][1] as { dispatcher?: unknown } | undefined;
    const dispatcher = init?.dispatcher as Record<symbol, unknown> | undefined;
    expect(dispatcher).toBeDefined();
    const dispatcherOptions = Object.getOwnPropertySymbols(dispatcher ?? {})
      .filter((sym) => sym.description === 'options')
      .map((sym) => (dispatcher as Record<symbol, unknown>)[sym])[0] as
        | { connect?: { rejectUnauthorized?: boolean }; uri?: string }
        | undefined;
    expect(dispatcherOptions?.connect?.rejectUnauthorized).toBe(false);
    expect(dispatcherOptions?.uri).toBeUndefined();
    expect(JSON.stringify(dispatcherOptions ?? {})).not.toContain('slow-proxy.invalid');
    expect(jest.getTimerCount()).toBe(0);

    // A body/fetch that ignores abort must not hold the crawler hostage.
    // Keep addresses from the homepage when a later contact page stalls.
    let contactStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => { contactStarted = resolve; });
    fetchMock.mockClear().mockImplementationOnce(async () => new Response(
      '<html><a href="/contact">Contact</a>sales@acme.ru</html>',
    )).mockImplementation(async () => {
      contactStarted();
      return new Promise<Response>(() => {});
    });
    const controller = new AbortController();
    const pending = scrapeEmails('https://acme.ru', {
      timeout: 1_000, maxPages: 12, signal: controller.signal,
    });
    await started;
    controller.abort();
    expect((await pending).emails).toEqual(['sales@acme.ru']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
    expect((await scrapeEmails('https://acme.ru', { signal: controller.signal })).emails).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});


describe('emailScraper failure reasons', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
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

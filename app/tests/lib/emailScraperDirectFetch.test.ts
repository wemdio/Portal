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

describe('emailScraper proxy retry falls back to another subnet', () => {
  const originalFetch = global.fetch;
  const originalPriority = process.env.YANDEXMAPS_PROXY_URLS_PRIORITY;
  const originalYandex = process.env.YANDEXMAPS_PROXY_URLS;
  const RU = 'http://u:p@ru-node.invalid:8000';
  const EU = 'http://u:p@eu-node.invalid:8000';

  // ProxyAgent хранит адрес прокси под символом kProxy = { uri, protocol }.
  const proxyHostOf = (init?: RequestInit): string | null => {
    const d = (init as { dispatcher?: Record<symbol, unknown> } | undefined)?.dispatcher;
    if (!d || d.constructor?.name !== 'ProxyAgent') return null;
    for (const sym of Object.getOwnPropertySymbols(d)) {
      const v = d[sym] as { uri?: string } | undefined;
      if (v && typeof v === 'object' && typeof v.uri === 'string') return new URL(v.uri).hostname;
    }
    return null;
  };

  beforeEach(() => {
    // Как на проде: YANDEXMAPS_PROXY_URLS содержит и RU-ноды тоже.
    process.env.YANDEXMAPS_PROXY_URLS_PRIORITY = JSON.stringify([RU]);
    process.env.YANDEXMAPS_PROXY_URLS = JSON.stringify([RU, EU]);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('@/lib/enrich/proxyPool').resetProxyGroupsCache();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalPriority === undefined) delete process.env.YANDEXMAPS_PROXY_URLS_PRIORITY;
    else process.env.YANDEXMAPS_PROXY_URLS_PRIORITY = originalPriority;
    if (originalYandex === undefined) delete process.env.YANDEXMAPS_PROXY_URLS;
    else process.env.YANDEXMAPS_PROXY_URLS = originalYandex;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('@/lib/enrich/proxyPool').resetProxyGroupsCache();
  });

  it('opens a site through another subnet when every RU node is refused (eksis.ru case)', async () => {
    const hosts: Array<string | null> = [];
    global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
      const host = proxyHostOf(init);
      hosts.push(host);
      if (host === 'eu-node.invalid') {
        return new Response('<html><body>sales@eksis.ru</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      return new Response('nope', { status: 403 });
    }) as unknown as typeof fetch;

    const result = await scrapeEmails('https://eksis.ru', {
      timeout: 1_000,
      maxPages: 1,
      stopAtFirstUsableEmail: true,
    });

    expect(result.emails).toEqual(['sales@eksis.ru']);
    expect(result.failureReason).toBeNull();
    // Порядок важен: сначала RU, потом другая подсеть.
    const proxied = hosts.filter(Boolean);
    expect(proxied).toEqual(['ru-node.invalid', 'eu-node.invalid']);
  });

  it('gives up after one RU and one other-subnet attempt, keeping the 403 reason', async () => {
    const hosts: Array<string | null> = [];
    global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
      hosts.push(proxyHostOf(init));
      return new Response('nope', { status: 403 });
    }) as unknown as typeof fetch;

    const result = await scrapeEmails('https://sepco.ru', { timeout: 500, maxPages: 1 });

    expect(result.emails).toEqual([]);
    expect(result.failureReason).toBe('Сайт блокирует автоматические запросы (403)');
    expect(hosts.filter(Boolean)).toEqual(['ru-node.invalid', 'eu-node.invalid']);
  });

  it('never picks a priority node as the other-subnet fallback', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pool = require('@/lib/enrich/proxyPool');
    const picks = Array.from({ length: 10 }, () => pool.pickNonPriorityProxyUrl());
    expect(new Set(picks)).toEqual(new Set([EU]));
  });
});

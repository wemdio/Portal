/** @jest-environment node */

/**
 * Regression test for production bug: fetchInnFromWebsite was using
 *   await import(/* webpackIgnore: true *\/ './innExtractor')
 * which Next.js prod bundler refused to resolve at runtime
 * (`Cannot find module '/app/.next/server/chunks/innExtractor'`),
 * making /api/enrich/inn-lookup return null for every URL.
 *
 * This test exercises the public contract of fetchInnFromWebsite end-to-end
 * with a mocked fetch — it must return the INN extracted from the response
 * HTML and must not throw a MODULE_NOT_FOUND-style error.
 */

jest.mock('@/lib/enrich/proxyPool', () => ({
  getProxyDispatcher: jest.fn(async () => undefined),
  getNonPriorityProxyDispatcher: jest.fn(async () => undefined),
}));

describe('fetchInnFromWebsite', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    jest.useRealTimers();
    jest.resetModules();
  });

  function mockHtml(html: string): void {
    global.fetch = jest.fn(async () =>
      new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
    ) as unknown as typeof fetch;
  }

  it('extracts company data and preserves emails/name discovery when search switches routes', async () => {
    mockHtml(`
      <html><body>
        <footer>ООО "Тест" ИНН: 7707083893 ОГРН 1027700132195</footer>
      </body></html>
    `);
    const { fetchInnFromWebsite, fetchWebsiteEmails } = await import('@/lib/enrich/websiteParser');
    const inn = await fetchInnFromWebsite('https://example.com', { timeout: 1_000 });
    expect(inn).toBe('7707083893');

    jest.useFakeTimers();
    const pool = await import('@/lib/enrich/proxyPool');
    const ru = {} as import('undici').Dispatcher;
    const other = {} as import('undici').Dispatcher;
    jest.mocked(pool.getProxyDispatcher).mockImplementation(async (priority = true) => priority ? ru : other);
    jest.mocked(pool.getNonPriorityProxyDispatcher).mockResolvedValue(other);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const calls: Array<{ path: string; route: unknown }> = [];
    const response = (html: string, status = 200) => new Response(html, {
      status, headers: { 'content-type': 'text/html; charset=utf-8' },
    });
    let loserSignal: AbortSignal | null = null;
    global.fetch = jest.fn(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const route = (init as RequestInit & { dispatcher?: unknown })?.dispatcher;
      calls.push({ path, route });
      if (route === ru) throw new TypeError('proxy route timed out');
      if (route === other) {
        loserSignal = init?.signal ?? null;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        });
      }
      if (path === '/contact') return response('<html>sales@acme.ru</html>');
      if (path === '/o-kompanii') return response('<html><meta property="og:site_name" content="Acme Factory"></html>');
      if (path === '/company') return response('<html>Not found</html>', 404);
      return response('<html><a href="/contact">Contact</a></html>');
    }) as typeof fetch;
    const recovered = await fetchWebsiteEmails('https://acme.ru', { adaptiveRoutes: true, maxPages: 1 });
    expect(recovered.emails).toEqual(['sales@acme.ru']);
    expect(recovered.brand_name).toBe('Acme Factory');
    // Names still come from /about pages AFTER emails are found; reuse direct
    // access for the site, and don't retry an ordinary missing /company page.
    expect(calls.filter((call) => call.path !== '/').map((call) => call.route)).toEqual([undefined, undefined, undefined]);
    expect(loserSignal).toHaveProperty('aborted', true);
    await Promise.resolve();
    expect(jest.getTimerCount()).toBe(0);

    // A fresh crawl starts RU-first; a fast direct 403 cannot win over a
    // successful alternate proxy. The winner is reused for its contact page.
    calls.length = 0;
    global.fetch = jest.fn(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const route = (init as RequestInit & { dispatcher?: unknown })?.dispatcher;
      calls.push({ path, route });
      if (route !== other) return response('Blocked', 403);
      await Promise.resolve();
      return response('<html><title>Acme Factory</title>sales@acme.ru</html>');
    }) as typeof fetch;
    expect((await fetchWebsiteEmails('https://acme.ru', { adaptiveRoutes: true, maxPages: 1 })).brand_name).toBe('Acme Factory');
    expect(calls[0].route).toBe(ru);
    expect(calls.filter((call) => call.path !== '/').every((call) => call.route === other)).toBe(true);

    // Opt-out retains the old policy: a readable 403 is returned, not raced.
    calls.length = 0;
    global.fetch = jest.fn(async (input, init) => {
      calls.push({ path: new URL(String(input)).pathname, route: (init as RequestInit & { dispatcher?: unknown })?.dispatcher });
      return response('<html><title>Acme Factory</title>sales@acme.ru</html>', 403);
    }) as typeof fetch;
    expect((await fetchWebsiteEmails('https://acme.ru', { maxPages: 1 })).emails).toEqual(['sales@acme.ru']);
    expect(calls.every((call) => call.route === ru)).toBe(true);

    // Caller cancellation stops BOTH retry routes and prevents later pages.
    const controller = new AbortController();
    const retrySignals: AbortSignal[] = [];
    let retriesStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => { retriesStarted = resolve; });
    global.fetch = jest.fn(async (_input, init) => {
      if ((init as RequestInit & { dispatcher?: unknown })?.dispatcher === ru) throw new Error('unreachable');
      retrySignals.push(init!.signal!);
      if (retrySignals.length === 2) retriesStarted();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
    }) as typeof fetch;
    const pending = fetchWebsiteEmails('https://acme.ru', { adaptiveRoutes: true, signal: controller.signal });
    await started;
    controller.abort();
    expect((await pending).emails).toEqual([]);
    expect(retrySignals.every((signal) => signal.aborted)).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(jest.getTimerCount()).toBe(0);

    // If every route stalls on a contact page, retain the homepage data and
    // spend two timeout windows, not three sequential ones. No real sleeps.
    global.fetch = jest.fn(async (input, init) => {
      if (new URL(String(input)).pathname === '/') {
        return response('<html><title>Acme Factory</title>sales@acme.ru</html>');
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
      });
    }) as typeof fetch;
    const stalled = fetchWebsiteEmails('https://acme.ru', { adaptiveRoutes: true, timeout: 1_000, maxPages: 1 });
    await jest.advanceTimersByTimeAsync(2_001);
    expect(await stalled).toMatchObject({ emails: ['sales@acme.ru'], brand_name: 'Acme Factory' });
    expect(global.fetch).toHaveBeenCalledTimes(4);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('extracts INN from JSON-LD / structured HTML attributes', async () => {
    mockHtml(`
      <html><head>
        <script type="application/ld+json">{"inn":"123456789012"}</script>
      </head><body><p>Hello</p></body></html>
    `);
    const { fetchInnFromWebsite } = await import('@/lib/enrich/websiteParser');
    const inn = await fetchInnFromWebsite('https://example.com', { timeout: 1_000 });
    expect(inn).toBe('123456789012');
  });

  it('returns null when the page contains no INN', async () => {
    mockHtml('<html><body><p>No company data here.</p></body></html>');
    const { fetchInnFromWebsite } = await import('@/lib/enrich/websiteParser');
    const inn = await fetchInnFromWebsite('https://example.com', { timeout: 1_000 });
    expect(inn).toBeNull();
  });

  it('does not throw MODULE_NOT_FOUND when the inn extractor is loaded', async () => {
    mockHtml('<html><body>ничего</body></html>');
    const { fetchInnFromWebsite } = await import('@/lib/enrich/websiteParser');
    await expect(
      fetchInnFromWebsite('https://example.com', { timeout: 1_000 }),
    ).resolves.not.toThrow();
  });

  it('does not start fallback requests with an already-aborted signal', async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    const controller = new AbortController();
    controller.abort();
    const { fetchAndExtract } = await import('@/lib/enrich/websiteParser');

    await expect(
      fetchAndExtract('https://example.com', { timeout: 1_000, signal: controller.signal }),
    ).rejects.toThrow();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  /**
   * Source-level guard. The original prod outage was caused by:
   *   await import(/* webpackIgnore: true *\/ './innExtractor')
   * which Jest resolves fine (so integration tests above pass) but the
   * Next.js prod bundler refuses to bundle, leading to runtime
   * `Cannot find module .../chunks/innExtractor` for every URL.
   *
   * This guard fails the suite if anyone reintroduces `webpackIgnore: true`
   * in this file.
   */
  it('source does not contain webpackIgnore-flagged dynamic imports (regression guard)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/lib/enrich/websiteParser.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/webpackIgnore\s*:\s*true/);
  });
});

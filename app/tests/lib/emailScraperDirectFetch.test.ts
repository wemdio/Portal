/**
 * @jest-environment node
 *
 * Regression for the 2026-07-30 base-constructor slowdown. PROXY_URLS is used
 * by other parsers, but email discovery must fetch sites directly: slow/dead
 * shared proxies used to consume the page timeout before a direct fallback.
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

  it('does not attach a proxy dispatcher even when PROXY_URLS is configured', async () => {
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
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('dispatcher');
  });
});

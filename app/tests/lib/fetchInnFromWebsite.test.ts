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

describe('fetchInnFromWebsite', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
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

  it('extracts INN from main-page HTML body text', async () => {
    mockHtml(`
      <html><body>
        <footer>ООО "Тест" ИНН: 7707083893 ОГРН 1027700132195</footer>
      </body></html>
    `);
    const { fetchInnFromWebsite } = await import('@/lib/enrich/websiteParser');
    const inn = await fetchInnFromWebsite('https://example.com', { timeout: 1_000 });
    expect(inn).toBe('7707083893');
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

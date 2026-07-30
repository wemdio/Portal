/**
 * @jest-environment node
 *
 * Связка «прокси → прямой запрос» в email-скрапере.
 *
 * Инцидент 30.07.2026: прокси из общего пула зависал, запрос висел до общего
 * таймаута строки (60с), и запасной прямой запрос уже не выполнялся —
 * строка уходила в ретрай (до 3 попыток). 33% строк вместо 5%.
 *
 * Правило: попытке через прокси даётся короткий бюджет, остаток времени
 * достаётся прямому запросу, а не отвечающий IP выпадает из ротации.
 */

import { fetchPage } from '@/lib/enrich/emailScraper';
import { __resetProxyPool, pickProxyUrl } from '@/lib/enrich/proxyPool';

const HTML = '<html><body>mail: hi@example.com</body></html>';

function htmlResponse(): Response {
  return new Response(HTML, { status: 200, headers: { 'content-type': 'text/html' } });
}

type FetchOpts = RequestInit & { dispatcher?: unknown };

describe('emailScraper — proxy fallback', () => {
  const originalFetch = global.fetch;
  const envBackup = { ...process.env };

  beforeEach(() => {
    process.env.PROXY_URLS = JSON.stringify(['http://user:pass@1.1.1.1:8000']);
    delete process.env.EMAIL_SCRAPER_PROXY;
    process.env.EMAIL_SCRAPER_PROXY_TIMEOUT_MS = '100';
    __resetProxyPool();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...envBackup };
  });

  it('uses the proxy when it answers, and does not fetch twice', async () => {
    const calls: FetchOpts[] = [];
    global.fetch = jest.fn(async (_url: unknown, opts: FetchOpts) => {
      calls.push(opts);
      return htmlResponse();
    }) as unknown as typeof fetch;

    const html = await fetchPage('https://example.com', { timeout: 5_000 });

    expect(html).toContain('hi@example.com');
    expect(calls).toHaveLength(1);
    expect(calls[0].dispatcher).toBeDefined();
  });

  it('retries directly when the proxy hangs, within the row budget', async () => {
    const calls: FetchOpts[] = [];
    global.fetch = jest.fn(async (_url: unknown, opts: FetchOpts) => {
      calls.push(opts);
      if (opts.dispatcher) {
        // висящий прокси: отдаём управление только когда попытку прервут
        return await new Promise<Response>((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      }
      return htmlResponse();
    }) as unknown as typeof fetch;

    const started = Date.now();
    const html = await fetchPage('https://example.com', { timeout: 5_000 });

    expect(html).toContain('hi@example.com');
    expect(calls).toHaveLength(2);
    expect(calls[0].dispatcher).toBeDefined();
    expect(calls[1].dispatcher).toBeUndefined();
    // прокси-попытка ограничена 100 мс, а не всем бюджетом строки
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('takes a dead proxy out of rotation after three hangs', async () => {
    global.fetch = jest.fn(async (_url: unknown, opts: FetchOpts) => {
      if (opts.dispatcher) throw new Error('ECONNREFUSED');
      return htmlResponse();
    }) as unknown as typeof fetch;

    for (let i = 0; i < 3; i += 1) {
      await fetchPage('https://example.com', { timeout: 5_000 });
    }

    expect(pickProxyUrl()).toBe('');
  });

  it('never touches a proxy when EMAIL_SCRAPER_PROXY=0', async () => {
    process.env.EMAIL_SCRAPER_PROXY = '0';
    __resetProxyPool();

    const calls: FetchOpts[] = [];
    global.fetch = jest.fn(async (_url: unknown, opts: FetchOpts) => {
      calls.push(opts);
      return htmlResponse();
    }) as unknown as typeof fetch;

    await fetchPage('https://example.com', { timeout: 5_000 });

    expect(calls).toHaveLength(1);
    expect(calls[0].dispatcher).toBeUndefined();
  });

  it('does not fall back after the caller cancels the job', async () => {
    const controller = new AbortController();
    const calls: FetchOpts[] = [];
    global.fetch = jest.fn(async (_url: unknown, opts: FetchOpts) => {
      calls.push(opts);
      controller.abort(); // пользователь отменил задание прямо во время запроса
      if (opts.signal?.aborted) throw new Error('aborted');
      return htmlResponse();
    }) as unknown as typeof fetch;

    const html = await fetchPage('https://example.com', {
      timeout: 5_000,
      signal: controller.signal,
    });

    expect(html).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

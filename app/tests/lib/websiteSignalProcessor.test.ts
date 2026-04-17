/** @jest-environment node */

jest.mock('server-only', () => ({}));

jest.mock('@/lib/enrich/websiteParser', () => ({
  fetchHtmlWithRetry: jest.fn(),
  fetchHtmlWithPlaywright: jest.fn(),
}));

import { processSignalsForUrl } from '@/lib/enrich/websiteSignalProcessor';
import { fetchHtmlWithRetry, fetchHtmlWithPlaywright } from '@/lib/enrich/websiteParser';

const fetchHtmlWithRetryMock = fetchHtmlWithRetry as jest.MockedFunction<typeof fetchHtmlWithRetry>;
const fetchHtmlWithPlaywrightMock = fetchHtmlWithPlaywright as jest.MockedFunction<typeof fetchHtmlWithPlaywright>;

const HTML_WITH_SIGNALS = `
<html>
  <head><title>Test</title></head>
  <body>
    <script src="https://mc.yandex.ru/metrika/tag.js"></script>
    <script src="https://yandex.ru/ads/system/context.js"></script>
    <script>VK.Retargeting.Init("VK-RTRG-1");</script>
  </body>
</html>
`;

describe('processSignalsForUrl', () => {
  beforeEach(() => {
    fetchHtmlWithRetryMock.mockReset();
    fetchHtmlWithPlaywrightMock.mockReset();
  });

  it('returns error without network calls when URL is invalid', async () => {
    const result = await processSignalsForUrl('not a url at all !!! ###');

    expect('error' in result).toBe(true);
    expect(fetchHtmlWithRetryMock).not.toHaveBeenCalled();
    expect(fetchHtmlWithPlaywrightMock).not.toHaveBeenCalled();
  });

  it('uses HTTP path on success and skips Playwright fallback', async () => {
    fetchHtmlWithRetryMock.mockResolvedValue({ html: HTML_WITH_SIGNALS, status: 200 });

    const result = await processSignalsForUrl('example.com');

    expect('stack' in result).toBe(true);
    if ('stack' in result) {
      expect(result.method).toBe('http');
      expect(result.stack).toContain('Яндекс.Метрика');
      expect(result.stack).toContain('Яндекс.Директ');
      expect(result.stack).toContain('VK Pixel');
      expect(result.profile).toBe('Тратит, но не считает');
      expect(result.signalIds.length).toBeGreaterThan(0);
    }
    expect(fetchHtmlWithRetryMock).toHaveBeenCalledTimes(1);
    expect(fetchHtmlWithPlaywrightMock).not.toHaveBeenCalled();
  });

  it('falls back to Playwright when HTTP returns null', async () => {
    fetchHtmlWithRetryMock.mockResolvedValue(null);
    fetchHtmlWithPlaywrightMock.mockResolvedValue(HTML_WITH_SIGNALS);

    const result = await processSignalsForUrl('example.com');

    expect('stack' in result).toBe(true);
    if ('stack' in result) {
      expect(result.method).toBe('playwright');
      expect(result.stack).toContain('Яндекс.Метрика');
    }
    expect(fetchHtmlWithRetryMock).toHaveBeenCalledTimes(1);
    expect(fetchHtmlWithPlaywrightMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to Playwright when HTTP returns non-2xx status', async () => {
    fetchHtmlWithRetryMock.mockResolvedValue({ html: '', status: 403 });
    fetchHtmlWithPlaywrightMock.mockResolvedValue(HTML_WITH_SIGNALS);

    const result = await processSignalsForUrl('example.com');

    expect('stack' in result).toBe(true);
    if ('stack' in result) expect(result.method).toBe('playwright');
    expect(fetchHtmlWithPlaywrightMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to Playwright when HTTP throws', async () => {
    fetchHtmlWithRetryMock.mockRejectedValue(new Error('network error'));
    fetchHtmlWithPlaywrightMock.mockResolvedValue(HTML_WITH_SIGNALS);

    const result = await processSignalsForUrl('example.com');

    expect('stack' in result).toBe(true);
    if ('stack' in result) expect(result.method).toBe('playwright');
  });

  it('returns error when both HTTP and Playwright fail', async () => {
    fetchHtmlWithRetryMock.mockResolvedValue(null);
    fetchHtmlWithPlaywrightMock.mockResolvedValue(null);

    const result = await processSignalsForUrl('example.com');

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it('returns empty stack/profile when fetched HTML has no detectable signals', async () => {
    fetchHtmlWithRetryMock.mockResolvedValue({
      html: '<html><body><h1>Hello world</h1></body></html>',
      status: 200,
    });

    const result = await processSignalsForUrl('example.com');

    expect('stack' in result).toBe(true);
    if ('stack' in result) {
      expect(result.stack).toBe('');
      expect(result.profile).toBe('');
      expect(result.signalIds).toEqual([]);
    }
  });
});

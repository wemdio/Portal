/** @jest-environment node */

import { yandexMapsCollectLinks, yandexMapsCollectLinksStream, yandexMapsParseOrgs, yandexMapsHealth } from '@/lib/parsers/yandexMapsServiceClient';
import type { CollectLinksChunk } from '@/lib/parsers/yandexMapsServiceClient';

function ndjsonResponse(lines: unknown[]) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(JSON.stringify(line) + '\n'));
      }
      controller.close();
    },
  });
  return { ok: true, status: 200, body };
}

describe('yandexMapsServiceClient', () => {
  const setFetchMock = (mock: typeof fetch) => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = mock;
  };

  beforeEach(() => {
    process.env.YANDEXMAPS_SERVICE_URL = 'http://localhost:8000';
    setFetchMock(jest.fn() as unknown as typeof fetch);
  });

  it('health returns true on ok', async () => {
    const fetchMock = (globalThis as unknown as { fetch: typeof fetch }).fetch as unknown as jest.Mock;
    fetchMock.mockResolvedValueOnce({ ok: true });
    await expect(yandexMapsHealth()).resolves.toBe(true);
  });

  it('collect-links posts json and returns links', async () => {
    const fetchMock = (globalThis as unknown as { fetch: typeof fetch }).fetch as unknown as jest.Mock;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ links: ['a', 'b'] }),
    });
    const res = await yandexMapsCollectLinks({ search_url: 'https://yandex.ru/maps/?text=x', max_results: 10, headless: true });
    expect(res.links).toEqual(['a', 'b']);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/collect-links',
      expect.objectContaining({ method: 'POST', signal: expect.any(Object) }),
    );
  });

  it('parse-orgs throws on non-ok', async () => {
    const fetchMock = (globalThis as unknown as { fetch: typeof fetch }).fetch as unknown as jest.Mock;
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'boom',
    });
    await expect(yandexMapsParseOrgs({ links: ['x'] })).rejects.toThrow('yandexmaps service error 500');
  });

  it('stream: heartbeat lines keep stream alive and do not pollute links', async () => {
    const fetchMock = (globalThis as unknown as { fetch: typeof fetch }).fetch as unknown as jest.Mock;
    fetchMock.mockResolvedValueOnce(ndjsonResponse([
      { links: ['https://yandex.ru/maps/org/a/1/'], total: 1 },
      { heartbeat: true, total: 1 },
      { heartbeat: true, total: 1 },
      { links: ['https://yandex.ru/maps/org/b/2/'], total: 2 },
      { done: true, total: 2 },
    ]));
    const chunks: CollectLinksChunk[] = [];
    const res = await yandexMapsCollectLinksStream(
      { search_url: 'https://yandex.ru/maps/?text=x' },
      (ch) => { chunks.push(ch); },
    );
    expect(res.links).toEqual(['https://yandex.ru/maps/org/a/1/', 'https://yandex.ru/maps/org/b/2/']);
    expect(res.total).toBe(2);
    expect(res.intlRedirect).toBe(false);
    // heartbeat-чанки доходят до колбэка (обновляют updated_at у задачи), но с пустыми links
    const heartbeats = chunks.filter((c) => c.heartbeat);
    expect(heartbeats).toHaveLength(2);
    expect(heartbeats.every((c) => c.links.length === 0)).toBe(true);
  });

  it('stream: intl_redirect flag from done line is propagated', async () => {
    const fetchMock = (globalThis as unknown as { fetch: typeof fetch }).fetch as unknown as jest.Mock;
    fetchMock.mockResolvedValueOnce(ndjsonResponse([
      { links: ['https://yandex.ru/maps/org/a/1/'], total: 1 },
      { done: true, total: 1, intl_redirect: true },
    ]));
    const res = await yandexMapsCollectLinksStream({ search_url: 'https://yandex.ru/maps/?text=x' }, () => {});
    expect(res.intlRedirect).toBe(true);
    expect(res.total).toBe(1);
  });

  it('retries and throws detailed error on fetch failure', async () => {
    process.env.YANDEXMAPS_SERVICE_MAX_RETRIES = '1';
    process.env.YANDEXMAPS_SERVICE_TIMEOUT_MS = '1000';
    const fetchMock = (globalThis as unknown as { fetch: typeof fetch }).fetch as unknown as jest.Mock;
    fetchMock.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    fetchMock.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    await expect(yandexMapsCollectLinks({ search_url: 'https://yandex.ru/maps/?text=x' })).rejects.toThrow('yandexmaps fetch failed');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});


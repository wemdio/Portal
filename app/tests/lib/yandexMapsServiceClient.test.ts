/** @jest-environment node */

import { yandexMapsCollectLinks, yandexMapsParseOrgs, yandexMapsHealth } from '@/lib/parsers/yandexMapsServiceClient';

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
      expect.objectContaining({ method: 'POST' }),
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
});


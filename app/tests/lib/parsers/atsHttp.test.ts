/** @jest-environment node */

import { fetchJsonWithFallback, fetchTextWithFallback } from '@/lib/parsers/atsHttp';

describe('ATS HTTP helper', () => {
  it('uses fetch when the response is successful', async () => {
    const curlImpl = jest.fn();
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => '{"ok":true}',
    });

    await expect(fetchJsonWithFallback('https://example.com/jobs', { fetchImpl, curlImpl })).resolves.toEqual({ ok: true });
    expect(curlImpl).not.toHaveBeenCalled();
  });

  it('falls back to curl when fetch fails or times out', async () => {
    const curlImpl = jest.fn().mockResolvedValue('{"fromCurl":true}');
    const fetchImpl = jest.fn().mockRejectedValue(new Error('TimeoutError'));

    await expect(fetchJsonWithFallback('https://api.lever.co/v0/postings/acme?mode=json', {
      fetchImpl,
      curlImpl,
    })).resolves.toEqual({ fromCurl: true });
    expect(curlImpl).toHaveBeenCalledWith(
      'https://api.lever.co/v0/postings/acme?mode=json',
      expect.objectContaining({ Accept: 'application/json' }),
      expect.any(Number),
    );
  });

  it('falls back to curl for non-2xx responses', async () => {
    const curlImpl = jest.fn().mockResolvedValue('ok from curl');
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'service unavailable',
    });

    await expect(fetchTextWithFallback('https://example.com/slow', { fetchImpl, curlImpl })).resolves.toBe('ok from curl');
  });
});

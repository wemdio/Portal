/**
 * Unit tests for client scoring endpoint integration.
 *
 * Тестируем нормализацию ответа (score/spf числами и строками, мусором),
 * обработку HTTP-ошибок, retry-логику. fetch замокан глобально, реальный
 * сетевой вызов не происходит.
 */

import { fetchScoreForDomain } from '@/lib/jobs/clientEndpointClient';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.useRealTimers();
});

function mockFetchSuccess(body: unknown, status = 200) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  });
}

function mockFetchHttp(status: number) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status,
    json: jest.fn().mockResolvedValue({}),
    text: jest.fn().mockResolvedValue(''),
  });
}

function mockFetchSequence(responses: Array<{ ok: boolean; status: number; body?: unknown } | Error>) {
  const fn = jest.fn();
  for (const r of responses) {
    if (r instanceof Error) {
      fn.mockRejectedValueOnce(r);
    } else {
      fn.mockResolvedValueOnce({
        ok: r.ok,
        status: r.status,
        json: jest.fn().mockResolvedValue(r.body ?? {}),
        text: jest.fn().mockResolvedValue(JSON.stringify(r.body ?? {})),
      });
    }
  }
  global.fetch = fn;
  return fn;
}

const BASE = { url: 'https://endpoint.example/score', apiKey: 'k1', domain: 'test.com' };

describe('fetchScoreForDomain — parsing', () => {
  it('returns parsed score and spf on numeric response', async () => {
    mockFetchSuccess({ score: 500, spf: 'v=spf1 -all' });
    const res = await fetchScoreForDomain(BASE);
    expect(res.ok).toBe(true);
    expect(res.score).toBe(500);
    expect(res.spf).toBe('v=spf1 -all');
  });

  it('coerces score from string to number', async () => {
    mockFetchSuccess({ score: '1000', spf: 'spf-string' });
    const res = await fetchScoreForDomain(BASE);
    expect(res.score).toBe(1000);
  });

  it('returns null score for non-numeric strings', async () => {
    mockFetchSuccess({ score: 'high', spf: 'spf' });
    const res = await fetchScoreForDomain(BASE);
    expect(res.ok).toBe(true);
    expect(res.score).toBeNull();
  });

  it('returns null score when field is missing', async () => {
    mockFetchSuccess({ spf: 'just-spf' });
    const res = await fetchScoreForDomain(BASE);
    expect(res.ok).toBe(true);
    expect(res.score).toBeNull();
    expect(res.spf).toBe('just-spf');
  });

  it('returns null spf when missing or empty', async () => {
    mockFetchSuccess({ score: 100, spf: '   ' });
    const res = await fetchScoreForDomain(BASE);
    expect(res.spf).toBeNull();
  });

  it('preserves the full body in raw for diagnostics', async () => {
    const body = { score: 1, spf: 'a', extra: 'field' };
    mockFetchSuccess(body);
    const res = await fetchScoreForDomain(BASE);
    expect(res.raw).toEqual(body);
  });

  it('marks non-object responses as error without retry', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue('a string'),
    });
    const res = await fetchScoreForDomain(BASE);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/non-object/i);
  });
});

describe('fetchScoreForDomain — HTTP errors', () => {
  it('returns error without retry on 4xx', async () => {
    const fn = mockFetchSequence([
      { ok: false, status: 401 },
    ]);
    const res = await fetchScoreForDomain(BASE);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('HTTP 401');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx and surfaces final error', async () => {
    const fn = mockFetchSequence([
      { ok: false, status: 503 },
      { ok: false, status: 503 },
      { ok: false, status: 503 },
    ]);
    const res = await fetchScoreForDomain({ ...BASE, timeoutMs: 100 });
    expect(res.ok).toBe(false);
    expect(fn).toHaveBeenCalledTimes(3);
  }, 30_000);

  it('succeeds on 5xx → 200 sequence', async () => {
    const fn = mockFetchSequence([
      { ok: false, status: 502 },
      { ok: true, status: 200, body: { score: 42, spf: 'ok' } },
    ]);
    const res = await fetchScoreForDomain({ ...BASE, timeoutMs: 100 });
    expect(res.ok).toBe(true);
    expect(res.score).toBe(42);
    expect(fn).toHaveBeenCalledTimes(2);
  }, 30_000);
});

describe('fetchScoreForDomain — request shape', () => {
  it('sends bearer token only when apiKey present', async () => {
    const fn = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({ score: 1, spf: 'a' }),
    });
    global.fetch = fn;
    await fetchScoreForDomain({ ...BASE, apiKey: 'secret-token' });
    const init = fn.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer secret-token');
  });

  it('omits Authorization header when apiKey is empty string', async () => {
    const fn = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({ score: 1, spf: 'a' }),
    });
    global.fetch = fn;
    await fetchScoreForDomain({ ...BASE, apiKey: '' });
    const init = fn.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('POSTs the domain as JSON body', async () => {
    const fn = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({ score: 1, spf: 'a' }),
    });
    global.fetch = fn;
    await fetchScoreForDomain({ ...BASE, domain: 'example.com' });
    const init = fn.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ domain: 'example.com' });
  });
});

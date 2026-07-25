/** @jest-environment node */

/**
 * Tests for the reg.ru regru2 client: response-shape strictness of
 * checkDomainsAvailable (a malformed success envelope must throw rather
 * than silently report everything as taken) and the availability mapping.
 * fetch is mocked — no network, no real credentials.
 */

import { checkDomainsAvailable } from '@/lib/regru/client';

const ORIGINAL_ENV = { ...process.env };

function mockFetchOnce(payload: unknown, ok = true, status = 200) {
  const fetchMock = jest.fn(async () => ({
    ok,
    status,
    json: async () => payload,
  }));
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

beforeEach(() => {
  process.env.REGRU_USERNAME = 'test-user';
  process.env.REGRU_PASSWORD = 'test-pass';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.restoreAllMocks();
});

describe('checkDomainsAvailable', () => {
  it('maps result=Available → true, error_code elements → false', async () => {
    mockFetchOnce({
      result: 'success',
      answer: {
        domains: [
          { dname: 'free.ru', result: 'Available' },
          { dname: 'taken.ru', result: 'Domain already exists, use whois service', error_code: 'DOMAIN_ALREADY_EXISTS' },
          { dname: 'bad.online', error_code: 'DOMAIN_BAD_NAME' },
        ],
      },
    });
    const res = await checkDomainsAvailable(['free.ru', 'taken.ru', 'bad.online']);
    expect(res).toEqual({ 'free.ru': true, 'taken.ru': false, 'bad.online': false });
  });

  it('sends ONE batched form-urlencoded request for the whole list', async () => {
    const fetchMock = mockFetchOnce({
      result: 'success',
      answer: { domains: [{ dname: 'a.ru', result: 'Available' }] },
    });
    await checkDomainsAvailable(['a.ru']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe('https://api.reg.ru/api/regru2/domain/check');
    expect(init.body).toContain('input_format=json');
    expect(init.body).toContain(encodeURIComponent('{"domains":[{"dname":"a.ru"}]}'));
  });

  it('throws when the success envelope has no domains array (malformed answer)', async () => {
    mockFetchOnce({ result: 'success', answer: {} });
    await expect(checkDomainsAvailable(['a.ru'])).rejects.toThrow(/no domains array/);
  });

  it('throws on top-level API errors (auth, ip denylist, …)', async () => {
    mockFetchOnce({
      result: 'error',
      error_code: 'RESELLER_AUTH_FAILED',
      error_text: 'Reseller authentication failed',
    });
    await expect(checkDomainsAvailable(['a.ru'])).rejects.toThrow(
      /Reseller authentication failed/,
    );
  });

  it('throws on HTTP errors', async () => {
    mockFetchOnce({}, false, 503);
    await expect(checkDomainsAvailable(['a.ru'])).rejects.toThrow(/HTTP 503/);
  });

  it('throws when no account is configured', async () => {
    delete process.env.REGRU_USERNAME;
    delete process.env.REGRU_PASSWORD;
    await expect(checkDomainsAvailable(['a.ru'])).rejects.toThrow(/no account configured/);
  });

  it('empty input → empty result without any HTTP call', async () => {
    const fetchMock = mockFetchOnce({});
    const res = await checkDomainsAvailable([]);
    expect(res).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

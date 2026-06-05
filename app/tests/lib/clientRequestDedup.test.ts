jest.mock('@/lib/authFetch', () => ({
  authFetchJson: jest.fn(),
}));

import { authFetchJson } from '@/lib/authFetch';
import { clientApiFetch } from '@/lib/clientFetcher';

const mockAuthFetchJson = authFetchJson as jest.MockedFunction<typeof authFetchJson>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('clientApiFetch request de-duplication', () => {
  beforeEach(() => {
    mockAuthFetchJson.mockReset();
  });

  it('shares one in-flight GET request for identical client API paths', async () => {
    const pending = deferred<{ ok: boolean }>();
    mockAuthFetchJson.mockReturnValueOnce(pending.promise);

    const first = clientApiFetch<{ ok: boolean }>('/tariff');
    const second = clientApiFetch<{ ok: boolean }>('/tariff');

    expect(mockAuthFetchJson).toHaveBeenCalledTimes(1);
    expect(mockAuthFetchJson).toHaveBeenCalledWith('/api/client/tariff', undefined);

    pending.resolve({ ok: true });

    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toEqual({ ok: true });

    mockAuthFetchJson.mockResolvedValueOnce({ ok: false });

    await expect(clientApiFetch<{ ok: boolean }>('/tariff')).resolves.toEqual({ ok: false });
    expect(mockAuthFetchJson).toHaveBeenCalledTimes(2);
  });

  it('does not de-duplicate mutating requests', async () => {
    mockAuthFetchJson
      .mockResolvedValueOnce({ saved: 1 })
      .mockResolvedValueOnce({ saved: 2 });

    const first = clientApiFetch('/billing', { method: 'POST', body: JSON.stringify({ plan: 'a' }) });
    const second = clientApiFetch('/billing', { method: 'POST', body: JSON.stringify({ plan: 'a' }) });

    await expect(first).resolves.toEqual({ saved: 1 });
    await expect(second).resolves.toEqual({ saved: 2 });
    expect(mockAuthFetchJson).toHaveBeenCalledTimes(2);
  });
});

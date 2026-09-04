/** @jest-environment node */

/**
 * Регрессия на транзиентный отказ провайдера (инцидент: стадия «Генерация
 * гипотез» падала на Requesty 502). rawCall обязан ретраить 408/425/429/5xx
 * с бэкоффом и НЕ ретраить постоянные 4xx.
 */

import { z } from 'zod';

jest.mock('@/lib/clientDemo/personalize', () => ({ assertPublicWebsite: jest.fn() }));
jest.mock('@/lib/enrich/websiteParser', () => ({
  normalizeUrl: (url: string) => url,
  fetchAndExtract: jest.fn(),
}));

import { assertPublicWebsite } from '@/lib/clientDemo/personalize';
import { fetchAndExtract } from '@/lib/enrich/websiteParser';
import { callLLMText, callLLMWithSchema, setVeActiveJobSignal } from '@/lib/verticalEngineV2/llm';
import { defaultFetchText, resolveFetchText, resolveSearch } from '@/lib/verticalEngineV2/stages/io';
import type { VeStageContext } from '@/lib/verticalEngineV2/stages/shared';

const schema = z.object({ ok: z.boolean() });

function httpResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('llm rawCall retry', () => {
  const envBackup = { ...process.env };
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.OPENROUTER_HYPOTHESIS_ENGINE_API_KEY = 'test-key';
    delete process.env.VE_LLM_TIMEOUT_MS;
    jest.useFakeTimers();
  });

  afterEach(() => {
    process.env = { ...envBackup };
    setVeActiveJobSignal(null);
    global.fetch = originalFetch;
    jest.useRealTimers();
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('retries a transient 502 and succeeds on the next attempt', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        httpResponse(502, { error: { origin: 'provider', message: 'unavailable' } }),
      )
      .mockResolvedValueOnce(
        httpResponse(200, { choices: [{ message: { content: '{"ok":true}' } }], usage: {} }),
      );
    global.fetch = fetchMock as unknown as typeof fetch;
    const pending = callLLMWithSchema(
      [{ role: 'user', content: 'json' }],
      schema,
      { model: 'test-model' },
    );
    await jest.advanceTimersByTimeAsync(2000);
    const result = await pending;

    expect(result.data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a permanent 4xx', async () => {
    const fetchMock = jest.fn().mockResolvedValue(httpResponse(400, { error: 'bad request' }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      callLLMWithSchema([{ role: 'user', content: 'json' }], schema, { model: 'test-model' }),
    ).rejects.toThrow(/Requesty 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after exhausting retries on 502', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(httpResponse(502, { error: { message: 'unavailable' } }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const assertion = expect(
      callLLMWithSchema([{ role: 'user', content: 'json' }], schema, { model: 'test-model' }),
    ).rejects.toThrow(/Requesty 502/);
    await jest.advanceTimersByTimeAsync(14_000);
    await assertion;
    // 1 исходный + 3 повтора = 4.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('bounds headers and response bodies, including the schema-repair attempt, with one deadline', async () => {
    for (const phase of ['headers', 'body', 'error-body', 'repair'] as const) {
      const response = deferred<Response>();
      const body = deferred<unknown>();
      const parent = new AbortController();
      setVeActiveJobSignal(parent.signal);
      const fetchMock = jest.fn().mockImplementation(() => phase === 'headers'
        ? response.promise
        : Promise.resolve({
            ...httpResponse(phase === 'error-body' ? 502 : 200, {}),
            json: () => body.promise,
            text: () => body.promise,
          }));
      if (phase === 'repair') fetchMock.mockImplementationOnce(() => response.promise);
      global.fetch = fetchMock as unknown as typeof fetch;
      let failure: unknown;
      const pending = phase === 'error-body'
        ? callLLMText([{ role: 'user', content: 'text' }], { model: 'test-model' })
        : callLLMWithSchema([{ role: 'user', content: 'json' }], schema, { model: 'test-model' });
      void pending.catch((error) => { failure = error; });
      await jest.advanceTimersByTimeAsync(200_000);
      if (phase === 'repair') {
        response.resolve(httpResponse(200, { choices: [{ message: { content: '{"ok":"invalid"}' } }] }));
        await jest.advanceTimersByTimeAsync(0);
      }
      expect(failure).toBeUndefined();
      await jest.advanceTimersByTimeAsync(100_000);
      expect(failure).toEqual(expect.objectContaining({ name: 'VeOperationTimeoutError', message: expect.stringMatching(/timeout/i) }));
      const requestSignal = (fetchMock.mock.calls.at(-1)?.[1] as RequestInit).signal;
      expect(requestSignal?.aborted).toBe(true);
      expect(parent.signal.aborted).toBe(false);
      // Late transport completion must neither retry nor repair with a new job's signal.
      setVeActiveJobSignal(new AbortController().signal);
      response.resolve(httpResponse(502, {}));
      body.resolve({ choices: [{ message: { content: '{"ok":"invalid"}' } }] });
      await jest.advanceTimersByTimeAsync(14_000);
      expect(fetchMock).toHaveBeenCalledTimes(phase === 'repair' ? 2 : 1);
      expect(jest.getTimerCount()).toBe(0);
    }
  });

  it('cancels backoff immediately and never starts a retry or a pre-cancelled request', async () => {
    const parent = new AbortController();
    setVeActiveJobSignal(parent.signal);
    const fetchMock = jest.fn().mockResolvedValue(httpResponse(502, {}));
    global.fetch = fetchMock as unknown as typeof fetch;
    let failure: unknown;
    void callLLMWithSchema([{ role: 'user', content: 'json' }], schema, { model: 'test-model' })
      .catch((error) => { failure = error; });
    await jest.advanceTimersByTimeAsync(0);
    parent.abort();
    await jest.advanceTimersByTimeAsync(0);
    expect(failure).toEqual(expect.objectContaining({ name: 'AbortError' }));
    await jest.advanceTimersByTimeAsync(14_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(callLLMText([], { model: 'test-model' })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not start website HTTP after a late DNS result, and aborts an active extraction', async () => {
    const dns = deferred<void>();
    jest.mocked(assertPublicWebsite).mockReturnValueOnce(dns.promise);
    let failure: unknown;
    void defaultFetchText('https://example.org').catch((error) => { failure = error; });
    await jest.advanceTimersByTimeAsync(8000);
    expect(failure).toEqual(expect.objectContaining({ name: 'VeOperationTimeoutError' }));
    dns.resolve();
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchAndExtract).not.toHaveBeenCalled();

    jest.mocked(assertPublicWebsite).mockResolvedValue(undefined);
    jest.mocked(fetchAndExtract).mockReturnValue(new Promise(() => {}));
    const parent = new AbortController();
    failure = undefined;
    void defaultFetchText('https://example.org', parent.signal).catch((error) => { failure = error; });
    await jest.advanceTimersByTimeAsync(0);
    parent.abort();
    await jest.advanceTimersByTimeAsync(0);
    expect(failure).toEqual(expect.objectContaining({ name: 'AbortError' }));
    expect(jest.mocked(fetchAndExtract).mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);

    // Real progress includes successful/error IO, but never a still-pending await.
    const activity = jest.fn();
    const page = deferred<string>();
    const customFetch = jest.fn().mockReturnValueOnce(page.promise).mockRejectedValueOnce(new Error('source failed'));
    const customSearch = jest.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('search failed'));
    const ctx = { fetchText: customFetch, search: customSearch, onActivity: activity } as unknown as VeStageContext;
    const fetchText = resolveFetchText(ctx);
    const search = resolveSearch(ctx);
    const fetching = fetchText('https://example.org');
    await jest.advanceTimersByTimeAsync(1000);
    expect(activity).not.toHaveBeenCalled();
    page.resolve('page text');
    await expect(fetching).resolves.toBe('page text');
    expect(activity).toHaveBeenCalledTimes(1);
    await expect(fetchText('https://example.org')).rejects.toThrow('source failed');
    expect(activity).toHaveBeenCalledTimes(2);
    await expect(search('market')).resolves.toEqual([]);
    await expect(search('market')).rejects.toThrow('search failed');
    expect(activity).toHaveBeenCalledTimes(4);
    expect(jest.getTimerCount()).toBe(0);
  });
});

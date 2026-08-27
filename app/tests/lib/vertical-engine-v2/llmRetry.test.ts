/** @jest-environment node */

/**
 * Регрессия на транзиентный отказ провайдера (инцидент: стадия «Генерация
 * гипотез» падала на Requesty 502). rawCall обязан ретраить 408/425/429/5xx
 * с бэкоффом и НЕ ретраить постоянные 4xx.
 */

import { z } from 'zod';

import { callLLMWithSchema } from '@/lib/verticalEngineV2/llm';

const schema = z.object({ ok: z.boolean() });

function httpResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  } as unknown as Response;
}

/** Прогоняет setTimeout синхронно, чтобы бэкоффы не растягивали тест. */
function instantTimers() {
  jest.spyOn(global, 'setTimeout').mockImplementation(((
    handler: (...args: unknown[]) => void,
  ) => {
    handler();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout);
}

describe('llm rawCall retry', () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    process.env.OPENROUTER_HYPOTHESIS_ENGINE_API_KEY = 'test-key';
  });

  afterEach(() => {
    process.env = { ...envBackup };
    jest.restoreAllMocks();
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
    instantTimers();

    const result = await callLLMWithSchema(
      [{ role: 'user', content: 'json' }],
      schema,
      { model: 'test-model' },
    );

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
    instantTimers();

    await expect(
      callLLMWithSchema([{ role: 'user', content: 'json' }], schema, { model: 'test-model' }),
    ).rejects.toThrow(/Requesty 502/);
    // 1 исходный + 3 повтора = 4.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

import { callOpenRouterChat, callOpenRouterChatRaw } from '@/lib/openrouter/client';

function makeFetchMock(
  body: unknown,
  options: { status?: number } = {},
): jest.Mock {
  return jest.fn(async () => {
    return {
      ok: (options.status ?? 200) < 400,
      status: options.status ?? 200,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  });
}

describe('callOpenRouterChatRaw', () => {
  it('возвращает content и finishReason из choice', async () => {
    const fetchMock = makeFetchMock({
      choices: [
        {
          message: { content: 'hello' },
          finish_reason: 'stop',
        },
      ],
    });

    const result = await callOpenRouterChatRaw({
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 0,
    });

    expect(result.content).toBe('hello');
    expect(result.finishReason).toBe('stop');
  });

  it('возвращает finishReason=length когда ответ обрезан', async () => {
    const fetchMock = makeFetchMock({
      choices: [
        {
          message: { content: '{"partial' },
          finish_reason: 'length',
        },
      ],
    });

    const result = await callOpenRouterChatRaw({
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 0,
    });

    expect(result.finishReason).toBe('length');
  });

  it('возвращает finishReason=undefined если провайдер не вернул', async () => {
    const fetchMock = makeFetchMock({
      choices: [{ message: { content: 'x' } }],
    });

    const result = await callOpenRouterChatRaw({
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 0,
    });

    expect(result.finishReason).toBeUndefined();
  });

  it('возвращает пустой content если choices отсутствуют', async () => {
    const fetchMock = makeFetchMock({});

    const result = await callOpenRouterChatRaw({
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 0,
    });

    expect(result.content).toBe('');
  });

  it('trim()-ит content', async () => {
    const fetchMock = makeFetchMock({
      choices: [{ message: { content: '  hello  \n' }, finish_reason: 'stop' }],
    });

    const result = await callOpenRouterChatRaw({
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 0,
    });

    expect(result.content).toBe('hello');
  });
});

describe('callOpenRouterChat (обёртка)', () => {
  it('возвращает только content (обратная совместимость)', async () => {
    const fetchMock = makeFetchMock({
      choices: [{ message: { content: 'legacy' }, finish_reason: 'stop' }],
    });

    const result = await callOpenRouterChat({
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 0,
    });

    expect(result).toBe('legacy');
    // Подтверждаем что это строка, не объект
    expect(typeof result).toBe('string');
  });
});

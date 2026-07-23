import {
  escapeMarkdownV2,
  sendMessage,
} from '@/lib/tgBot/telegramClient';

describe('telegramClient', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalFetch === undefined) {
      delete (globalThis as { fetch?: typeof fetch }).fetch;
    } else {
      globalThis.fetch = originalFetch;
    }
  });

  it('экранирует спецсимволы MarkdownV2', () => {
    expect(escapeMarkdownV2('Hello_world.test!')).toBe(
      'Hello\\_world\\.test\\!',
    );
  });

  it('отправляет plain-text сообщение без parse_mode', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await sendMessage('token', { chatId: 123, text: 'Отчёт' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      chat_id: 123,
      text: 'Отчёт',
    });
  });
});

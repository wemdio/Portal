/** @jest-environment node */

import { postHandoffMessage } from '@/lib/instantly/handoffTelegram';

const fetchMock = jest.fn();

describe('postHandoffMessage', () => {
  const oldFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 42 } }),
    });
  });

  afterAll(() => {
    global.fetch = oldFetch;
  });

  it('с callbackData — reply_markup с кнопкой «Передать клиенту»', async () => {
    const id = await postHandoffMessage({ token: 't', chatId: 'c', text: 'x', callbackData: 'h.q-1.sig' });
    expect(id).toBe(42);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as {
      reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] };
    };
    expect(body.reply_markup.inline_keyboard[0][0]).toEqual({
      text: '➡️ Передать клиенту',
      callback_data: 'h.q-1.sig',
    });
  });

  it('без callbackData — reply_markup НЕТ (инфо-карточка авто-режима)', async () => {
    await postHandoffMessage({ token: 't', chatId: 'c', text: 'x' });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as {
      reply_markup?: unknown;
    };
    expect(body.reply_markup).toBeUndefined();
  });
});

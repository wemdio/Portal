/** @jest-environment node */

/**
 * json_object-режим Requesty отклоняет запрос с 400, если ни одно сообщение не
 * содержит слова «json». Все промпты v2 формат упоминают, кроме досье (его
 * system собирается прямо в stages/dossier.ts) — стадия dossier падала на
 * каждом прогоне. Гейт живёт в llm.ts, а не в промпте: так защищён и любой
 * следующий инлайновый промпт.
 */

import { z } from 'zod';

import { callLLMWithSchema } from '@/lib/verticalEngineV2/llm';

const schema = z.object({ ok: z.boolean() });

function mockOk(payload: unknown) {
  return jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(payload) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  });
}

function sentBody(fetchMock: jest.Mock): { messages: Array<{ role: string; content: string }>; response_format?: unknown } {
  return JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
}

describe('callLLMWithSchema — json_object guard', () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    process.env.OPENROUTER_HYPOTHESIS_ENGINE_API_KEY = 'test-key';
  });

  afterEach(() => {
    process.env = { ...envBackup };
    jest.restoreAllMocks();
  });

  it('injects a JSON instruction when the prompt never mentions the format', async () => {
    const fetchMock = mockOk({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;

    await callLLMWithSchema(
      [
        { role: 'system', content: 'Опиши сегмент по присланным счётчикам.' },
        { role: 'user', content: '{"counters":{"companies_total":10}}' },
      ],
      schema,
      { model: 'test-model' },
    );

    const body = sentBody(fetchMock);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(JSON.stringify(body.messages)).toMatch(/json/i);
  });

  it('leaves prompts that already mention JSON untouched', async () => {
    const fetchMock = mockOk({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;

    const messages = [
      { role: 'system' as const, content: 'Верни JSON строго по схеме.' },
      { role: 'user' as const, content: 'сегмент' },
    ];
    await callLLMWithSchema(messages, schema, { model: 'test-model' });

    expect(sentBody(fetchMock).messages).toEqual(messages);
  });
});

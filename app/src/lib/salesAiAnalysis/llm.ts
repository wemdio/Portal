/**
 * LLM-хелпер с JSON-schema валидацией. Вызывает claude-haiku-4-5 через
 * Requesty (тот же провайдер, что у sales_copilot), форсит response_format:
 * json_object, парсит и валидирует Zod-схемой, ретрайит 1 раз при mismatch.
 *
 * Цены (Anthropic Haiku 4.5 через Requesty, USD/M токенов):
 *   input:  $1.00
 *   output: $5.00
 * Если сменим модель — обновить MODEL_PRICES.
 */

import { z } from 'zod';

const API_URL = 'https://router.requesty.ai/v1/chat/completions';

interface RequestyResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
}

type ModelPrices = { in: number; out: number };
const MODEL_PRICES: Record<string, ModelPrices> = {
  'claude-haiku-4-5':                { in: 1.0, out: 5.0 },
  'anthropic/claude-haiku-4-5':      { in: 1.0, out: 5.0 },
  'claude-sonnet-5':                 { in: 3.0, out: 15.0 }, // на случай upgrade
  'anthropic/claude-sonnet-5':       { in: 3.0, out: 15.0 },
};

function getApiKey(): string {
  const key = process.env.OPENROUTER_SALES_AI_API_KEY
           || process.env.OPENROUTER_SALES_COPILOT_API_KEY
           || process.env.OPENROUTER_TG_OUTREACH_API_KEY;
  if (!key) throw new Error('OPENROUTER_SALES_AI_API_KEY не задан');
  return key;
}

function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const p = MODEL_PRICES[model] ?? MODEL_PRICES['claude-haiku-4-5'];
  return (promptTokens / 1_000_000) * p.in + (completionTokens / 1_000_000) * p.out;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResult<T> {
  data: T;
  tokensUsed: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  rawResponse: unknown;
}

export class LLMValidationError extends Error {
  constructor(message: string, public readonly rawText: string, public readonly zodError?: unknown) {
    super(message);
    this.name = 'LLMValidationError';
  }
}

async function rawCall(
  messages: LLMMessage[],
  model: string,
  maxTokens: number,
): Promise<{ text: string; response: RequestyResponse }> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getApiKey()}` },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Requesty ${res.status}: ${text.slice(0, 300)}`);
  }
  const response = (await res.json()) as RequestyResponse;
  const text = response.choices?.[0]?.message?.content ?? '';
  return { text, response };
}

/**
 * Один LLM-вызов с response_format=json_object + Zod-валидация ответа.
 * При невалидном JSON — 1 retry с system-фидбэком об ошибке. Если и второй
 * раз невалидно — бросает LLMValidationError (воркер помечает job failed).
 */
export async function callLLMWithSchema<T>(
  messages: LLMMessage[],
  schema: z.ZodType<T>,
  opts: { model: string; maxTokens?: number },
): Promise<LLMResult<T>> {
  const maxTokens = opts.maxTokens ?? 4096;

  const attempts: Array<{ text: string; error?: string }> = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    const currentMessages: LLMMessage[] = [...messages];
    if (attempt > 0 && attempts[0]) {
      currentMessages.push(
        { role: 'assistant', content: attempts[0].text.slice(0, 2000) },
        { role: 'user', content:
          `Твой предыдущий ответ не прошёл валидацию JSON-схемы. Ошибка:\n` +
          `${attempts[0].error}\n\n` +
          `Верни валидный JSON строго по схеме. Никаких markdown-фенсов, никакого текста до/после.`,
        },
      );
    }

    const { text, response } = await rawCall(currentMessages, opts.model, maxTokens);
    const usage = response.usage || {};
    const promptTokens = usage.prompt_tokens ?? 0;
    const completionTokens = usage.completion_tokens ?? 0;

    // strip markdown fences if модель их всё-таки добавила
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      attempts.push({ text, error: `JSON.parse failed: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }

    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      attempts.push({
        text,
        error: JSON.stringify(validated.error.format()).slice(0, 800),
      });
      continue;
    }

    return {
      data: validated.data,
      tokensUsed: usage.total_tokens ?? promptTokens + completionTokens,
      promptTokens,
      completionTokens,
      costUsd: estimateCost(opts.model, promptTokens, completionTokens),
      rawResponse: response,
    };
  }

  const last = attempts[attempts.length - 1]!;
  throw new LLMValidationError(
    `LLM вернул невалидный JSON дважды: ${last.error}`,
    last.text,
  );
}

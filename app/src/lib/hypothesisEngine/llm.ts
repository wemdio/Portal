/**
 * LLM-хелпер «Движка вертикалей». Копия паттерна salesAiAnalysis/llm.ts:
 * Requesty router (OpenAI-compatible), response_format: json_object +
 * Zod-валидация + 1 retry с фидбэком об ошибке, учёт токенов/стоимости.
 *
 * Отличия от salesAiAnalysis:
 *  - свой ключ: OPENROUTER_HYPOTHESIS_ENGINE_API_KEY (fallback OPENROUTER_BRIEF_API_KEY);
 *  - три роли моделей (см. getHeModel): research / chain / bulk;
 *  - дополнительный callLLMText — свободный текст без json_object
 *    (цепочки писем парсятся маркерами ---LETTER N---, а не схемой).
 *
 * Цены (USD/M токенов) — по прайсу Requesty на момент написания; при смене
 * моделей обновить MODEL_PRICES. Фолбэк-оценка — по самой дорогой (opus),
 * чтобы не занижать фактическую стоимость прогона.
 */

import { z } from 'zod';

const API_URL = 'https://router.requesty.ai/v1/chat/completions';

interface RequestyResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
}

type ModelPrices = { in: number; out: number };
const MODEL_PRICES: Record<string, ModelPrices> = {
  // Ресёрч/синтез (site_profile, hypotheses, evidence, clustering)
  // opus-5: прайс Requesty уточнить после первых прогонов, пока = opus-4-8
  'claude-opus-5':                  { in: 5.0, out: 25.0 },
  'anthropic/claude-opus-5':        { in: 5.0, out: 25.0 },
  'claude-opus-4-8':                { in: 5.0, out: 25.0 },
  'anthropic/claude-opus-4-8':      { in: 5.0, out: 25.0 },
  // Bulk: vocab, brand_cloud-классификация, base_analyze
  'claude-sonnet-4-6':              { in: 3.0, out: 15.0 },
  'anthropic/claude-sonnet-4-6':    { in: 3.0, out: 15.0 },
  // Цепочки/шаблоны (как emailSequenceV2)
  'gpt-5.2':                        { in: 1.25, out: 10.0 },
  'openai/gpt-5.2':                 { in: 1.25, out: 10.0 },
  // На случай downgrade через env
  'claude-haiku-4-5':               { in: 1.0, out: 5.0 },
  'anthropic/claude-haiku-4-5':     { in: 1.0, out: 5.0 },
};

const FALLBACK_PRICES: ModelPrices = MODEL_PRICES['anthropic/claude-opus-4-8'];

function getApiKey(): string {
  const key = process.env.OPENROUTER_HYPOTHESIS_ENGINE_API_KEY || process.env.OPENROUTER_BRIEF_API_KEY;
  if (!key) {
    throw new Error('OPENROUTER_HYPOTHESIS_ENGINE_API_KEY не задан (и нет fallback OPENROUTER_BRIEF_API_KEY)');
  }
  return key;
}

function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const p = MODEL_PRICES[model] ?? FALLBACK_PRICES;
  return (promptTokens / 1_000_000) * p.in + (completionTokens / 1_000_000) * p.out;
}

/* ─────────────────────── Роли моделей ─────────────────────── */

export type HeModelKind = 'research' | 'chain' | 'bulk';

const HE_MODEL_DEFAULTS: Record<HeModelKind, string> = {
  research: 'anthropic/claude-opus-5',
  chain: 'openai/gpt-5.2',
  bulk: 'anthropic/claude-sonnet-4-6',
};

const HE_MODEL_ENV: Record<HeModelKind, string> = {
  research: 'HE_MODEL_RESEARCH',
  chain: 'HE_MODEL_CHAIN',
  bulk: 'HE_MODEL_BULK',
};

/** Модель для роли движка; переопределяется env HE_MODEL_RESEARCH/CHAIN/BULK. */
export function getHeModel(kind: HeModelKind): string {
  return (process.env[HE_MODEL_ENV[kind]] ?? '').trim() || HE_MODEL_DEFAULTS[kind];
}

/* ─────────────────────── Базовые типы/вызов ─────────────────────── */

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

export interface LLMTextResult {
  text: string;
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
  jsonMode: boolean,
): Promise<{ text: string; response: RequestyResponse }> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getApiKey()}` },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
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

function usageOf(response: RequestyResponse): { promptTokens: number; completionTokens: number; tokensUsed: number } {
  const usage = response.usage || {};
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    tokensUsed: usage.total_tokens ?? promptTokens + completionTokens,
  };
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

    const { text, response } = await rawCall(currentMessages, opts.model, maxTokens, true);
    const { promptTokens, completionTokens, tokensUsed } = usageOf(response);

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
      tokensUsed,
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

/**
 * Свободный текст без json_object — для генерации цепочек писем и финальных
 * шаблонов (парсинг маркерами ---LETTER N--- через letterParser).
 * Без retry: валидность текста проверяет вызывающая стадия.
 */
export async function callLLMText(
  messages: LLMMessage[],
  opts: { model: string; maxTokens?: number },
): Promise<LLMTextResult> {
  const maxTokens = opts.maxTokens ?? 8192;
  const { text, response } = await rawCall(messages, opts.model, maxTokens, false);
  const { promptTokens, completionTokens, tokensUsed } = usageOf(response);
  return {
    text: text.trim(),
    tokensUsed,
    promptTokens,
    completionTokens,
    costUsd: estimateCost(opts.model, promptTokens, completionTokens),
    rawResponse: response,
  };
}

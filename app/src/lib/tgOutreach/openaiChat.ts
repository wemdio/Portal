import type { OpenAISettings, DialogMessage } from './types';

// Requesty fallback chain policy: gpt-5-mini → gpt-4o-mini → gpt-5.
// Retries and model fallback handled by Requesty, not by us.
const DEFAULT_MODEL = 'policy/tg-outreach';

interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenRouterResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

// Retry config for transient OpenRouter failures (5xx, timeouts).
// gpt-5-mini on OpenRouter sporadically returns 500 "provider error" or
// hangs past the timeout — a single retry with backoff resolves most cases.
const RETRY_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = [3_000, 6_000];

function isRetryable(status: number): boolean {
  return status >= 500 && status < 600;
}

export async function openaiGenerate(
  settings: OpenAISettings,
  chatHistory: DialogMessage[],
): Promise<string | null> {
  const apiKey = process.env.OPENROUTER_TG_OUTREACH_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_TG_OUTREACH_API_KEY не задан в .env');
  }

  const messages: OpenAIChatMessage[] = [];

  if (settings.system_prompt) {
    let prompt = settings.system_prompt;
    if (settings.project_name) {
      prompt = prompt.replace(/\{project_name\}/g, settings.project_name);
    }
    messages.push({ role: 'system', content: prompt });
  }

  for (const msg of chatHistory) {
    messages.push({ role: msg.role, content: msg.content });
  }

  // Всегда используем Requesty policy — fallback chain рулит моделями.
  // settings.llm_model игнорируем: в БД у старых кампаний лежит конкретная
  // модель (openai/gpt-5-mini), которая обходит fallback chain.
  const model = DEFAULT_MODEL;

  const body = {
    model,
    messages,
    max_tokens: 4096,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };

  // 90s по умолчанию: gpt-5-mini тратит 25-35с на reasoning в типичном
  // случае, но на сложных промптах (длинная история диалога) может уходить
  // в 60-80с. Прежний лимит 45с резал ~15% успешных запросов. Override
  // через env, если нужно.
  const GPT_TIMEOUT_MS = Number(process.env.TG_OUTREACH_GPT_TIMEOUT_MS) || 90_000;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const backoff = RETRY_BACKOFF_MS[attempt - 1] ?? 6_000;
      await new Promise(r => setTimeout(r, backoff));
    }

    try {
      const res = await fetch('https://router.requesty.ai/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(GPT_TIMEOUT_MS),
      });

      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`OpenRouter API error ${res.status}: ${text.slice(0, 200)}`);
        if (isRetryable(res.status) && attempt < RETRY_ATTEMPTS) {
          lastError = err;
          continue;
        }
        throw err;
      }

      const data = (await res.json()) as OpenRouterResponse;
      return data.choices?.[0]?.message?.content?.trim() ?? null;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError' || err.message.includes('TIMEOUT');
      if ((isTimeout || (lastError && lastError.message.includes('500'))) && attempt < RETRY_ATTEMPTS) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  throw lastError ?? new Error('OpenRouter: all retry attempts exhausted');
}

export function detectTrigger(
  text: string,
  settings: OpenAISettings,
): 'positive' | 'negative' | null {
  const lower = text.toLowerCase();

  if (settings.trigger_phrases_positive) {
    const phrases = settings.trigger_phrases_positive
      .split('\n')
      .map(p => p.trim().toLowerCase())
      .filter(Boolean);
    for (const phrase of phrases) {
      if (lower.includes(phrase)) return 'positive';
    }
  }

  if (settings.trigger_phrases_negative) {
    const phrases = settings.trigger_phrases_negative
      .split('\n')
      .map(p => p.trim().toLowerCase())
      .filter(Boolean);
    for (const phrase of phrases) {
      if (lower.includes(phrase)) return 'negative';
    }
  }

  return null;
}

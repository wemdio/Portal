// Изолированный клиент к Gemini 3.1 Pro через тот же прокси портала
// (router.requesty.ai), с включённым веб-поиском для живого ресёрча
// компании-адресата. Не переиспользует openrouter/client.ts: тот не
// поддерживает поле `tools`, нужное здесь.

const ENDPOINT = process.env.OPENROUTER_ENDPOINT ?? 'https://router.requesty.ai/v1/chat/completions';

// TODO(проверить перед первым запуском в проде): точный id модели «Gemini
// 3.1 Pro» в Model Library Requesty (https://app.requesty.ai/model-library)
// может отличаться по написанию — свериться и при необходимости обновить
// REPLY_PERSONALIZATION_MODEL_ID в .env.
const MODEL_ID = process.env.REPLY_PERSONALIZATION_MODEL_ID ?? 'vertex/google/gemini-3-pro-preview';

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 90_000;
const TOTAL_TIMEOUT_MS = 240_000;
const INITIAL_MAX_TOKENS = 1500;
const MAX_TOKENS_CAP = 6000;

export class ReplyGenerationError extends Error {}

export interface GeminiReplyResult {
  text: string;
  sources: { url: string; title?: string }[];
}

interface RequestyChoice {
  message?: { content?: string; web_search?: { url?: string; title?: string }[] };
  finish_reason?: string;
}

export async function generateReplyWithSearch(messages: { role: string; content: string }[]): Promise<GeminiReplyResult> {
  const apiKey = process.env.OPENROUTER_REPLY_PERSONALIZATION_API_KEY ?? process.env.OPENROUTER_BRIEF_API_KEY ?? '';
  if (!apiKey) {
    throw new ReplyGenerationError('OPENROUTER_REPLY_PERSONALIZATION_API_KEY not configured on server');
  }

  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  let maxTokens = INITIAL_MAX_TOKENS;
  let lastError: Error = new ReplyGenerationError('Generation failed for unknown reason');

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw lastError;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(REQUEST_TIMEOUT_MS, remainingMs));

    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: MODEL_ID,
          messages,
          max_tokens: maxTokens,
          temperature: 0.4,
          tools: [{ type: 'web_search' }],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        lastError = new ReplyGenerationError(`Requesty error ${response.status}: ${await response.text().catch(() => '')}`);
        continue;
      }

      const data = (await response.json()) as { choices?: RequestyChoice[] };
      const choice = data.choices?.[0];
      const content = choice?.message?.content?.trim() ?? '';

      if (choice?.finish_reason === 'length') {
        lastError = new ReplyGenerationError('Ответ обрезан по длине (finish_reason=length)');
        maxTokens = Math.min(MAX_TOKENS_CAP, maxTokens * 2);
        continue;
      }

      if (!content) {
        lastError = new ReplyGenerationError('Пустой ответ модели');
        continue;
      }

      const sources = (choice?.message?.web_search ?? [])
        .filter((s): s is { url: string; title?: string } => Boolean(s.url))
        .map((s) => ({ url: s.url, title: s.title }));

      return { text: content, sources };
    } catch (err) {
      lastError = err instanceof Error ? err : new ReplyGenerationError('Unknown error');
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}

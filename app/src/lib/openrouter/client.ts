/**
 * Лёгкий клиент к нашему OpenRouter-прокси (router.requesty.ai).
 * Делит retry-логику и заголовки между фичами (briefScoring, projectBriefHypotheses, ...).
 */

const DEFAULT_OPENROUTER_ENDPOINT =
  process.env.OPENROUTER_ENDPOINT ?? 'https://router.requesty.ai/v1/chat/completions';

export type OpenRouterRole = 'system' | 'user' | 'assistant';

export interface OpenRouterMessage {
  role: OpenRouterRole;
  content: string;
}

export interface OpenRouterChatOptions {
  apiKey: string;
  model: string;
  messages: OpenRouterMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: 'json_object' } | { type: 'text' };
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  endpoint?: string;
  /** HTTP-Referer header for OpenRouter analytics (defaults to https://portal.app). */
  referer?: string;
  /** X-Title header for OpenRouter analytics. */
  title?: string;
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

const RETRYABLE_STATUS = new Set([502, 503, 504]);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calls the OpenRouter chat-completions endpoint and returns the raw `content`
 * string of the first choice. Caller is responsible for parsing.
 */
export async function callOpenRouterChat(options: OpenRouterChatOptions): Promise<string> {
  const {
    apiKey,
    model,
    messages,
    temperature = 0.2,
    maxTokens,
    responseFormat,
    signal,
    fetchImpl = fetch,
    endpoint = DEFAULT_OPENROUTER_ENDPOINT,
    referer = 'https://portal.app',
    title = 'Portal',
    maxRetries = 3,
    retryBaseDelayMs = 1500,
  } = options;

  if (!apiKey) throw new Error('OpenRouter API key is not configured');
  if (!model) throw new Error('Missing required field: model');
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('Missing required field: messages (non-empty array)');
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature,
  };
  if (typeof maxTokens === 'number') body.max_tokens = maxTokens;
  if (responseFormat) body.response_format = responseFormat;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': referer,
          'X-Title': title,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      if (attempt < maxRetries) {
        await sleep(retryBaseDelayMs * Math.pow(2, attempt));
        continue;
      }
      const msg = err instanceof Error ? err.message : 'Network error';
      throw new Error(`Ошибка сети при обращении к AI: ${msg}`);
    }

    if (response.ok) {
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content?.trim() ?? '';
      return content;
    }

    let errorMessage = `API error: ${response.status}`;
    try {
      const errorData = (await response.json()) as { error?: { message?: string } };
      errorMessage = errorData.error?.message || errorMessage;
    } catch {
      // ignore parsing errors
    }

    if (RETRYABLE_STATUS.has(response.status) && attempt < maxRetries) {
      await sleep(retryBaseDelayMs * Math.pow(2, attempt));
      continue;
    }

    throw new Error(errorMessage);
  }

  throw new Error('Не удалось получить ответ от AI после нескольких попыток');
}

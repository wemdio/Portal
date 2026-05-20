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
 * OpenRouter finish_reason — кодирует ПОЧЕМУ генерация закончилась.
 *
 * Самое важное для нас: `length` означает что ответ упёрся в max_tokens и был
 * обрезан. Без явной проверки этого значения мы вынуждены угадывать
 * truncation эвристикой (см. autofill/index.ts старая логика "starts with {
 * but does not end").
 *
 * Точные значения зависят от модели/провайдера. Документировано как минимум:
 * stop | length | tool_calls | content_filter | function_call | error
 */
export type OpenRouterFinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'function_call'
  | 'error'
  | string
  | null
  | undefined;

export interface OpenRouterChatRawResult {
  /** Текст ответа (уже trim()-нут). Может быть пустой строкой. */
  content: string;
  /** finish_reason первого choice. undefined если провайдер его не вернул. */
  finishReason: OpenRouterFinishReason;
}

/**
 * Calls the OpenRouter chat-completions endpoint and returns the raw `content`
 * string of the first choice. Caller is responsible for parsing.
 *
 * Если нужен finish_reason — используй callOpenRouterChatRaw.
 */
export async function callOpenRouterChat(options: OpenRouterChatOptions): Promise<string> {
  const { content } = await callOpenRouterChatRaw(options);
  return content;
}

/**
 * Same as callOpenRouterChat but ALSO returns finish_reason.
 *
 * Используется в местах где важно различать "модель естественно закончила"
 * (stop) и "ответ обрезан на лимите токенов" (length) — например, в autofill,
 * чтобы отличать "AI не нашёл фактов на сайте" от "ответ обрезан, надо
 * повторить с другим maxTokens".
 */
export async function callOpenRouterChatRaw(
  options: OpenRouterChatOptions,
): Promise<OpenRouterChatRawResult> {
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
      const rawText = await response.text();
      let data: {
        choices?: Array<{
          message?: { content?: string };
          finish_reason?: OpenRouterFinishReason;
        }>;
      };
      try {
        data = JSON.parse(rawText);
      } catch {
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error(`AI вернул невалидный ответ: ${rawText.slice(0, 200)}`);
        data = JSON.parse(jsonMatch[0]);
      }
      const choice = data.choices?.[0];
      const content = choice?.message?.content?.trim() ?? '';
      const finishReason = choice?.finish_reason;
      return { content, finishReason };
    }

    let errorMessage = `API error: ${response.status}`;
    try {
      const rawErr = await response.text();
      const errorData = JSON.parse(rawErr) as { error?: { message?: string } };
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

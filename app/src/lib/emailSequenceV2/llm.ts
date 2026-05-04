import 'server-only';

/**
 * LLM-обёртка для инструмента «Цепочки писем 2.0».
 * Использует ОТДЕЛЬНЫЙ API ключ Requesty, чтобы можно было выставить
 * собственные лимиты/биллинг и не делить квоту с email-sequence v1.
 *
 * env (приоритет):
 * 1) OPENROUTER_EMAIL_SEQUENCE_V2_API_KEY — основной ключ для v2.
 * 2) OPENROUTER_EMAIL_SEQUENCE_API_KEY — fallback на ключ v1, чтобы инструмент
 *    не падал, если v2-ключ ещё не создан в Requesty.
 */

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

type RouterResponse = {
  model?: unknown;
  output_text?: unknown;
  error?: { message?: unknown } | null;
  choices?: Array<{
    text?: unknown;
    finish_reason?: unknown;
    message?: {
      content?: unknown;
      tool_calls?: unknown;
      refusal?: unknown;
    } | null;
  }> | null;
};

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function getApiKey(): string {
  const v2 = (process.env.OPENROUTER_EMAIL_SEQUENCE_V2_API_KEY ?? '').trim();
  if (v2) return v2;
  // Fallback: пока не настроен отдельный ключ — используем существующий v1.
  return (process.env.OPENROUTER_EMAIL_SEQUENCE_API_KEY ?? '').trim();
}

function extractTextFromMaybeContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value) return '';
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        const p = part as Record<string, unknown>;
        if (typeof p.text === 'string') return p.text;
        const txt = p.text as Record<string, unknown> | undefined;
        if (txt && typeof txt === 'object' && typeof txt.value === 'string') return String(txt.value);
        if (typeof p.content === 'string') return p.content;
        return '';
      })
      .join('');
  }
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.text === 'string') return v.text;
    if (typeof v.content === 'string') return v.content;
  }
  return '';
}

function extractAssistantText(data: RouterResponse | null | undefined): string {
  const choice = data?.choices?.[0];
  const fromMessage = extractTextFromMaybeContent(choice?.message?.content ?? null);
  if (fromMessage.trim()) return fromMessage.trim();

  const fromText = typeof choice?.text === 'string' ? choice.text : '';
  if (fromText.trim()) return fromText.trim();

  const outputText = typeof data?.output_text === 'string' ? data.output_text : '';
  if (outputText.trim()) return outputText.trim();

  return '';
}

function normalizeOpenAiModel(model: string): string {
  const trimmed = String(model ?? '').trim();
  if (!trimmed) return 'openai/gpt-5.2';
  if (trimmed.includes('/')) return trimmed;
  return `openai/${trimmed}`;
}

export type CallLLMOptions = {
  messages: ChatMessage[];
  model: string;
  timeoutMs?: number;
  maxRetries?: number;
  temperature?: number;
  maxTokens?: number;
  title?: string;
  responseFormat?: 'json_object' | 'text';
};

export async function callLLM({
  messages,
  model,
  timeoutMs = 180_000,
  maxRetries = 3,
  temperature = 0.5,
  maxTokens = 4000,
  title = 'Portal - Email Sequence v2',
  responseFormat,
}: CallLLMOptions): Promise<string> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error(
      'Не настроен ключ Requesty: установите OPENROUTER_EMAIL_SEQUENCE_V2_API_KEY (или, как fallback, OPENROUTER_EMAIL_SEQUENCE_API_KEY) в .env',
    );
  }

  const normalizedModel = normalizeOpenAiModel(model);

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch('https://router.requesty.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://portal.app',
          'X-Title': title,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: normalizedModel,
          messages,
          temperature,
          max_tokens: maxTokens,
          ...(responseFormat ? { response_format: { type: responseFormat } } : {}),
        }),
      });

      const raw = await res.text();
      let data: RouterResponse | null = null;
      try {
        data = (raw ? (JSON.parse(raw) as unknown) : null) as RouterResponse | null;
      } catch {
        // ignore json parse errors; raw will surface below
      }

      if (res.ok) {
        const maybeOkErr = data?.error?.message;
        if (typeof maybeOkErr === 'string' && maybeOkErr.trim()) {
          throw new Error(maybeOkErr);
        }
        const content = extractAssistantText(data);
        if (!content) {
          const choice = data?.choices?.[0];
          const finish = choice?.finish_reason ?? null;
          const modelEcho = typeof data?.model === 'string' ? data.model : normalizedModel;
          throw new Error(
            `Пустой ответ от модели (model=${String(modelEcho)}, finish_reason=${String(finish)})`,
          );
        }
        return content;
      }

      const retryable = [502, 503, 504, 429].includes(res.status);
      if (retryable && attempt < maxRetries) {
        await sleep(1500 * Math.pow(2, attempt));
        continue;
      }

      let msg = `Router API error: ${res.status}`;
      const errMsg = data?.error?.message;
      if (typeof errMsg === 'string' && errMsg.trim()) msg = errMsg;
      throw new Error(msg);
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      if ((isAbort || attempt < maxRetries) && attempt < maxRetries) {
        await sleep(1500 * Math.pow(2, attempt));
        continue;
      }
      const message = err instanceof Error ? err.message : 'Unknown error';
      throw new Error(`Запрос к модели не удался: ${message}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  throw new Error('Запрос к модели не удался после повторов');
}

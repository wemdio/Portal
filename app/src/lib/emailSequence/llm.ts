import 'server-only';

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

type OpenRouterResponse = {
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

function redactErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

function getOpenRouterKey(): string {
  return (process.env.OPENROUTER_EMAIL_SEQUENCE_API_KEY ?? '').trim();
}

function extractTextFromMaybeContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value) return '';

  // Some providers/OpenAI-compatible gateways may return an array of parts.
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

  // Rarely, content might be an object (non-standard). Try common fields.
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.text === 'string') return v.text;
    if (typeof v.content === 'string') return v.content;
  }

  return '';
}

function extractAssistantText(data: OpenRouterResponse | null | undefined): string {
  const choice = data?.choices?.[0];
  const fromMessage = extractTextFromMaybeContent(choice?.message?.content ?? null);
  if (fromMessage.trim()) return fromMessage.trim();

  const fromText = typeof choice?.text === 'string' ? choice.text : '';
  if (fromText.trim()) return fromText.trim();

  // Some OpenAI-compatible implementations return output_text at top-level.
  const outputText = typeof data?.output_text === 'string' ? data.output_text : '';
  if (outputText.trim()) return outputText.trim();

  return '';
}

function normalizeOpenRouterOpenAiModel(model: string): string {
  const trimmed = String(model ?? '').trim();
  if (!trimmed) return 'openai/gpt-5.2';
  if (trimmed.includes('/')) return trimmed;
  return `openai/${trimmed}`;
}

function normalizeOpenRouterPerplexityModel(model: string): string {
  const trimmed = String(model ?? '').trim();
  if (!trimmed) return 'perplexity/sonar-pro';
  if (trimmed.includes('/')) return trimmed;
  return `perplexity/${trimmed}`;
}

async function callOpenRouter({
  messages,
  model,
  timeoutMs,
  maxRetries,
  temperature,
  maxTokens,
  title,
}: {
  messages: ChatMessage[];
  model: string;
  timeoutMs: number;
  maxRetries: number;
  temperature: number;
  maxTokens: number;
  title: string;
}): Promise<string> {
  const apiKey = getOpenRouterKey();
  if (!apiKey) throw new Error('OPENROUTER_EMAIL_SEQUENCE_API_KEY not configured on server');

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), timeoutMs);
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
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
        }),
      });

      const raw = await res.text();
      let data: OpenRouterResponse | null = null;
      try {
        data = (raw ? (JSON.parse(raw) as unknown) : null) as OpenRouterResponse | null;
      } catch {
        // Ignore; we'll fall back to raw text.
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
          const hasToolCalls = choice?.message?.tool_calls != null;
          const hasRefusal = choice?.message?.refusal != null;
          const modelEcho = typeof data?.model === 'string' ? data.model : model;
          throw new Error(
            `Empty response from OpenRouter (model=${String(modelEcho)}, finish_reason=${String(finish)}, tool_calls=${String(
              hasToolCalls,
            )}, refusal=${String(hasRefusal)})`,
          );
        }
        return content;
      }

      const retryable = [502, 503, 504].includes(res.status);
      if (retryable && attempt < maxRetries) {
        await sleep(1200 * Math.pow(2, attempt));
        continue;
      }

      let msg = `OpenRouter API error: ${res.status}`;
      try {
        const err = (data ?? ((raw ? (JSON.parse(raw) as unknown) : null) as OpenRouterResponse | null)) as OpenRouterResponse | null;
        const errMsg = err?.error?.message;
        if (typeof errMsg === 'string' && errMsg.trim()) msg = errMsg;
      } catch {
        // ignore
      }
      throw new Error(msg);
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      if ((isAbort || attempt < maxRetries) && attempt < maxRetries) {
        await sleep(1200 * Math.pow(2, attempt));
        continue;
      }
      throw new Error(`OpenRouter request failed: ${redactErr(err)}`);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  throw new Error('OpenRouter request failed after retries');
}

export async function callPerplexity({
  messages,
  model = 'sonar-pro',
  timeoutMs = 120_000,
  maxRetries = 3,
}: {
  messages: ChatMessage[];
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
}): Promise<string> {
  return callOpenRouter({
    messages,
    model: normalizeOpenRouterPerplexityModel(model),
    timeoutMs,
    maxRetries,
    temperature: 0.2,
    maxTokens: 2500,
    title: 'Portal - Email Sequence - Perplexity',
  });
}

export async function callOpenAI({
  messages,
  model,
  timeoutMs = 120_000,
  maxRetries = 3,
  temperature = 0.5,
  maxTokens = 2200,
}: {
  messages: ChatMessage[];
  model: string;
  timeoutMs?: number;
  maxRetries?: number;
  temperature?: number;
  maxTokens?: number;
}): Promise<string> {
  return callOpenRouter({
    messages,
    model: normalizeOpenRouterOpenAiModel(model),
    timeoutMs,
    maxRetries,
    temperature,
    maxTokens,
    title: 'Portal - Email Sequence - Writer',
  });
}


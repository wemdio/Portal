import type { ConversationMessage, ToolDefinition, LlmResponse, ToolCall } from './types';

const MODEL = 'anthropic/claude-sonnet-4-6';
const TIMEOUT_MS = 90_000;
const MAX_RETRIES = 2;

function getApiKey(): string {
  return (process.env.OPENROUTER_AGENT_API_KEY ?? '').trim();
}

type OpenRouterChoice = {
  message?: {
    content?: string | null;
    tool_calls?: Array<{
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>;
  } | null;
};

type OpenRouterResponse = {
  choices?: OpenRouterChoice[] | null;
  error?: { message?: string } | null;
};

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function callLlm(
  messages: ConversationMessage[],
  tools: ToolDefinition[],
): Promise<LlmResponse> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('OPENROUTER_AGENT_API_KEY not configured');

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const res = await fetch('https://router.requesty.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://portal.app',
          'X-Title': 'Portal - Telegram Agent',
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: MODEL,
          messages,
          tools: tools.length > 0 ? tools : undefined,
          tool_choice: tools.length > 0 ? 'auto' : undefined,
          temperature: 0.2,
          max_tokens: 8000,
        }),
      });

      const raw = await res.text();
      let data: OpenRouterResponse | null = null;
      try {
        data = JSON.parse(raw) as OpenRouterResponse;
      } catch {
        /* ignore parse error */
      }

      if (res.ok) {
        if (data?.error?.message) throw new Error(data.error.message);

        const choice = data?.choices?.[0];
        const content = choice?.message?.content ?? null;
        const rawToolCalls = choice?.message?.tool_calls ?? [];

        const toolCalls: ToolCall[] = rawToolCalls
          .filter((tc) => tc.function?.name)
          .map((tc, i) => ({
            id: tc.id ?? `call_${i}`,
            type: 'function' as const,
            function: {
              name: tc.function!.name!,
              arguments: tc.function?.arguments ?? '{}',
            },
          }));

        return { content: content?.trim() || null, toolCalls };
      }

      if ([502, 503, 504].includes(res.status) && attempt < MAX_RETRIES) {
        await sleep(1500 * Math.pow(2, attempt));
        continue;
      }

      const errMsg = data?.error?.message ?? `OpenRouter API error: ${res.status}`;
      throw new Error(errMsg);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError' && attempt < MAX_RETRIES) {
        await sleep(1500 * Math.pow(2, attempt));
        continue;
      }
      if (attempt >= MAX_RETRIES) {
        throw new Error(`LLM request failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  throw new Error('LLM request failed after retries');
}

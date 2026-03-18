import type { CopilotDraftMessage } from './types';

interface OpenRouterResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { total_tokens?: number };
}

export interface GenerateResult {
  text: string | null;
  tokensUsed: number | null;
}

export async function generateDraft(
  history: CopilotDraftMessage[],
  systemPrompt: string,
  model: string,
): Promise<GenerateResult> {
  const apiKey = process.env.OPENROUTER_TG_OUTREACH_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_TG_OUTREACH_API_KEY не задан');

  const messages: { role: string; content: string }[] = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  for (const msg of history) {
    messages.push({ role: msg.role, content: msg.content });
  }

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, max_tokens: 512 }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as OpenRouterResponse;
  return {
    text: data.choices?.[0]?.message?.content?.trim() ?? null,
    tokensUsed: data.usage?.total_tokens ?? null,
  };
}

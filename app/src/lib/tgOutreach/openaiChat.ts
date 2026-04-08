import type { OpenAISettings, DialogMessage } from './types';

const DEFAULT_MODEL = 'openai/gpt-4o-mini';

interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenRouterResponse {
  choices?: Array<{ message?: { content?: string } }>;
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

  const model = settings.llm_model || DEFAULT_MODEL;

  const body = {
    model,
    messages,
    max_tokens: 1024,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };

  const res = await fetch('https://router.requesty.ai/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as OpenRouterResponse;
  return data.choices?.[0]?.message?.content?.trim() ?? null;
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

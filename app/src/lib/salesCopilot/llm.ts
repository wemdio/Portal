import type { CopilotDraftMessage } from './types';

interface OpenRouterResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { total_tokens?: number };
}

export interface GenerateResult {
  text: string | null;
  tokensUsed: number | null;
}

const API_URL = 'https://router.requesty.ai/v1/chat/completions';

function getApiKey(): string {
  const key = process.env.OPENROUTER_TG_OUTREACH_API_KEY;
  if (!key) throw new Error('OPENROUTER_TG_OUTREACH_API_KEY не задан');
  return key;
}

async function callLLM(
  messages: { role: string; content: string }[],
  model: string,
  maxTokens: number = 512,
): Promise<OpenRouterResponse> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getApiKey()}` },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 200)}`);
  }

  return (await res.json()) as OpenRouterResponse;
}

const CLASSIFY_PROMPT = `Ты — аналитик отдела продаж. Тебе дана переписка менеджера с клиентом в Telegram. Диалог замолк {silence_days} дней назад.

Оцени, стоит ли менеджеру написать клиенту снова.

НЕ стоит писать если:
- Клиент явно отказал ("не интересно", "нет, спасибо", "не нужно")
- Клиент попросил больше не писать
- Менеджер сам закрыл диалог ("понял, спасибо за ответ")
- Диалог был спамом или ошибкой

СТОИТ писать если:
- Клиент сказал "подумаю", "обсудим", "позже вернусь" и замолчал
- Был интерес но разговор оборвался без чёткого финала
- Клиент задавал вопросы но не дошёл до сделки
- Обсуждали конкретику (цены, сроки, условия) но не закрыли

Ответь ОДНИМ словом: ДА или НЕТ. Ничего больше.`;

export interface ClassifyResult {
  shouldReengage: boolean;
  tokensUsed: number | null;
}

export async function classifyDialog(
  history: CopilotDraftMessage[],
  silenceDays: number,
  model: string,
): Promise<ClassifyResult> {
  const systemPrompt = CLASSIFY_PROMPT.replace(/\{silence_days\}/g, String(silenceDays));
  const messages: { role: string; content: string }[] = [
    { role: 'system', content: systemPrompt },
  ];
  for (const msg of history) {
    messages.push({ role: msg.role, content: msg.content });
  }

  const data = await callLLM(messages, model, 8);
  const answer = (data.choices?.[0]?.message?.content ?? '').trim().toUpperCase();

  return {
    shouldReengage: answer.startsWith('ДА') || answer.startsWith('DA') || answer === 'YES',
    tokensUsed: data.usage?.total_tokens ?? null,
  };
}

export async function generateDraft(
  history: CopilotDraftMessage[],
  systemPrompt: string,
  model: string,
): Promise<GenerateResult> {
  const messages: { role: string; content: string }[] = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  for (const msg of history) {
    messages.push({ role: msg.role, content: msg.content });
  }

  const data = await callLLM(messages, model);
  return {
    text: data.choices?.[0]?.message?.content?.trim() ?? null,
    tokensUsed: data.usage?.total_tokens ?? null,
  };
}

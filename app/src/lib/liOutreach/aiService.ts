import 'server-only';

import type { LiLead } from './types';

/**
 * AI Service for LinkedIn message personalization and auto-replies.
 * Port of Python linkedin-ai-responder/app/services/ai_service.py → TypeScript.
 */

// ---- Template parsing ---------------------------------------------------

interface LeadInfo {
  name?: string;
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  position?: string | null;
}

export function parseMessageTemplate(template: string, lead: LeadInfo): string {
  let result = template;

  const firstName = lead.first_name || (lead.name ? lead.name.split(/\s+/)[0] : '') || '';
  const lastName = lead.last_name || (lead.name && lead.name.split(/\s+/).length > 1 ? lead.name.split(/\s+/).pop() : '') || '';

  const placeholders: Record<string, string> = {
    name: firstName,
    first_name: firstName,
    last_name: lastName,
    full_name: lead.name ?? '',
    company: lead.company ?? '',
    position: lead.position ?? '',
  };

  // Replace {{placeholder}} (double braces)
  for (const [key, value] of Object.entries(placeholders)) {
    for (const variant of [key, key.toUpperCase(), key.charAt(0).toUpperCase() + key.slice(1)]) {
      const pattern = `{{${variant}}}`;
      result = result.replaceAll(pattern, value);
    }
  }
  // Clean remaining {{...}}
  result = result.replace(/\{\{[^{}]+\}\}/g, '');

  // Replace {placeholder} (single braces, WITHOUT pipe)
  for (const [key, value] of Object.entries(placeholders)) {
    for (const variant of [key, key.toUpperCase(), key.charAt(0).toUpperCase() + key.slice(1)]) {
      const pattern = `{${variant}}`;
      if (result.includes(pattern)) {
        result = result.replaceAll(pattern, value);
      }
    }
  }

  // Handle {option1|option2} variations
  result = result.replace(/\{([^{}]+\|[^{}]+)\}/g, (_match, group: string) => {
    const variants = group.split('|');
    return variants[Math.floor(Math.random() * variants.length)]!.trim();
  });

  // Cleanup
  result = result.replace(/\s+/g, ' ').trim();
  result = result.replace(/\s+([.,!?])/g, '$1');
  result = result.replace(/([.,!?])\s*([.,!?])/g, '$1');

  return result;
}

export function leadToInfo(lead: LiLead): LeadInfo {
  return {
    name: lead.name,
    first_name: lead.first_name,
    last_name: lead.last_name,
    company: lead.company,
    position: lead.position,
  };
}

function formatLeadContext(lead: LeadInfo): string {
  const parts: string[] = [];
  const firstName = lead.first_name || (lead.name ? lead.name.split(/\s+/)[0] : '');
  const lastName = lead.last_name || '';
  if (firstName) parts.push(`Имя: ${firstName}`);
  if (lastName) parts.push(`Фамилия: ${lastName}`);
  if (lead.position) parts.push(`Должность: ${lead.position}`);
  if (lead.company) parts.push(`Компания: ${lead.company}`);
  return parts.length ? parts.join('\n') : 'Информация о собеседнике недоступна';
}

// ---- OpenAI calls -------------------------------------------------------

interface AiConfig {
  apiKey: string;
  model?: string;
}

async function makeOpenAiRequest(
  messages: Array<{ role: string; content: string }>,
  config: AiConfig,
  maxTokens = 150,
): Promise<string | null> {
  if (!config.apiKey) return null;
  const model = config.model || 'gpt-4o-mini';

  const isNewModel = /gpt-5|o1|o3/i.test(model);
  const payload: Record<string, unknown> = { model, messages };
  if (isNewModel) payload.max_completion_tokens = maxTokens;
  else payload.max_tokens = maxTokens;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // Fallback to gpt-4o-mini if model not found
      if ((res.status === 404 || res.status === 400) && (text.toLowerCase().includes('model') || text.toLowerCase().includes('max_tokens'))) {
        return makeOpenAiRequest(messages, { ...config, model: 'gpt-4o-mini' }, maxTokens);
      }
      console.error(`[li-outreach][ai] OpenAI ${res.status}: ${text.slice(0, 300)}`);
      return null;
    }

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    let text = (data.choices?.[0]?.message?.content ?? '').trim();
    // Remove surrounding quotes
    if (text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
    return text || null;
  } catch (e) {
    console.error('[li-outreach][ai] request failed:', e instanceof Error ? e.message : e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---- Public API ---------------------------------------------------------

const DEFAULT_PERSONALIZE_PROMPT = `Ты эксперт по персонализации сообщений в LinkedIn. Твоя задача - создать персонализированное сообщение.

ПРАВИЛА:
1. Если сообщение на русском, транслитерируй имя (Yehor→Егор, Ekaterina→Екатерина)
2. Используй должность чтобы описать сферу (Crypto|Payments → криптоплатежах и финтехе)
3. Никаких скобок с инструкциями в результате
4. Не более 300 символов
5. Результат — готовое к отправке сообщение`;

const DEFAULT_REPLY_PROMPT = `Ты профессиональный ассистент для общения в LinkedIn.
Отвечай вежливо, по делу и кратко. Деловой, но дружелюбный тон.
Отвечай на том же языке, на котором написано сообщение.
Старайся продвигать разговор к цели (звонок, встреча, сотрудничество).`;

export async function personalizeInviteMessage(
  baseMessage: string,
  lead: LeadInfo,
  config: AiConfig,
  systemPrompt?: string | null,
): Promise<string> {
  if (!config.apiKey) return baseMessage;
  const leadCtx = formatLeadContext(lead);

  const userPrompt = `Создай персонализированное сообщение:\n\nШАБЛОН:\n${baseMessage}\n\nДАННЫЕ О ЧЕЛОВЕКЕ:\n${leadCtx}\n\nНапиши готовое сообщение (только текст):`;
  const messages = [
    { role: 'system', content: systemPrompt || DEFAULT_PERSONALIZE_PROMPT },
    { role: 'user', content: userPrompt },
  ];

  const result = await makeOpenAiRequest(messages, config, 200);
  if (!result) return baseMessage;
  return result.length > 300 ? `${result.slice(0, 297)}...` : result;
}

export async function personalizeFollowUp(
  baseMessage: string,
  lead: LeadInfo,
  conversationHistory: Array<{ role: string; content: string }>,
  config: AiConfig,
  systemPrompt?: string | null,
): Promise<string> {
  if (!config.apiKey) return baseMessage;
  const leadCtx = formatLeadContext(lead);

  let contextText = '';
  if (conversationHistory.length > 0) {
    contextText = '\n\nПредыдущие сообщения:\n';
    for (const msg of conversationHistory.slice(-5)) {
      const role = msg.role === 'assistant' ? 'Я' : 'Собеседник';
      contextText += `${role}: ${msg.content.slice(0, 100)}\n`;
    }
  }

  const userPrompt = `ШАБЛОН:\n${baseMessage}\n\nДАННЫЕ:\n${leadCtx}\n${contextText}\nНапиши готовое сообщение:`;
  const messages = [
    { role: 'system', content: systemPrompt || DEFAULT_PERSONALIZE_PROMPT },
    { role: 'user', content: userPrompt },
  ];

  return (await makeOpenAiRequest(messages, config, 250)) ?? baseMessage;
}

export async function generateAutoReply(
  incomingMessage: string,
  conversationHistory: Array<{ role: string; content: string }>,
  config: AiConfig,
  systemPrompt?: string | null,
  lead?: LeadInfo | null,
): Promise<string | null> {
  if (!config.apiKey) return null;

  let sysContent = systemPrompt || DEFAULT_REPLY_PROMPT;
  if (lead) sysContent += `\n\nИнформация о собеседнике:\n${formatLeadContext(lead)}`;

  const messages: Array<{ role: string; content: string }> = [{ role: 'system', content: sysContent }];
  for (const msg of conversationHistory.slice(-10)) {
    if (msg.content.trim()) messages.push({ role: msg.role, content: msg.content });
  }
  messages.push({ role: 'user', content: incomingMessage });

  return makeOpenAiRequest(messages, config, 500);
}

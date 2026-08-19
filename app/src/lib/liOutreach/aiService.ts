import 'server-only';

import { AI_FOLLOWUP_FORMAT_RULES } from './aiOutputGuard';
import {
  buildTemplateVarValues,
  resolveTemplateVar,
  type TemplateLeadInfo,
} from './messageVars';
import type { LiLead } from './types';

/**
 * AI Service for LinkedIn message personalization and auto-replies.
 * Port of Python linkedin-ai-responder/app/services/ai_service.py → TypeScript.
 */

// ---- Template parsing ---------------------------------------------------

type LeadInfo = TemplateLeadInfo;

export function parseMessageTemplate(template: string, lead: LeadInfo): string {
  let result = template;

  const values = buildTemplateVarValues(lead);

  // Replace {{placeholder}} (double braces). Lookup is case- and
  // separator-insensitive (see messageVars), so the camelCase vocabulary the
  // team learns from /reglament — {{firstName}}, {{companyName}} — renders the
  // same as {{first_name}}. Before that, camelCase matched nothing and fell
  // through to the "clean remaining" pass below, i.e. every name silently
  // became an empty string (prod 2026-08: 145 of 160 invites went out
  // nameless). Unknown tags still collapse to '' so raw braces can never
  // reach a lead — findUnknownPlaceholders is what surfaces them, at save
  // time in the campaign API and as a warning in the campaign log.
  result = result.replace(
    /\{\{([^{}]+)\}\}/g,
    (_match, raw: string) => resolveTemplateVar(values, raw) ?? '',
  );

  // Replace {placeholder} (single braces, WITHOUT pipe). An unknown token is
  // left verbatim: single braces are ordinary punctuation in a chat message,
  // unlike {{...}} which is unambiguously a merge tag.
  result = result.replace(
    /\{([^{}|]+)\}/g,
    (match, raw: string) => resolveTemplateVar(values, raw) ?? match,
  );

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

/**
 * Requesty's router (`router.requesty.ai`) accepts model names only in the
 * `provider/model` shape — bare names like `gpt-4o-mini` return 400 with
 * `Invalid model, expected: "provider/model"`. We default the provider to
 * `openai` because that's the historical default for LI outreach campaigns;
 * operators who want a non-OpenAI model can still pick one explicitly by
 * typing the full `vendor/name`, e.g. `anthropic/claude-3-5-sonnet`.
 *
 * Exported so the unit test can pin the contract without going through the
 * full HTTP request path.
 */
export function normalizeModel(model: string | null | undefined): string {
  const trimmed = (model ?? '').trim();
  if (!trimmed) return 'openai/gpt-4o-mini';
  return trimmed.includes('/') ? trimmed : `openai/${trimmed}`;
}

async function makeOpenAiRequest(
  messages: Array<{ role: string; content: string }>,
  config: AiConfig,
  maxTokens = 150,
): Promise<string | null> {
  if (!config.apiKey) return null;
  const model = normalizeModel(config.model);

  const isNewModel = /gpt-5|o1|o3/i.test(model);
  const payload: Record<string, unknown> = { model, messages };
  if (isNewModel) payload.max_completion_tokens = maxTokens;
  else payload.max_tokens = maxTokens;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  try {
    const res = await fetch('https://router.requesty.ai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // Fallback to gpt-4o-mini if model not found
      if ((res.status === 404 || res.status === 400) && (text.toLowerCase().includes('model') || text.toLowerCase().includes('max_tokens'))) {
        return makeOpenAiRequest(messages, { ...config, model: 'openai/gpt-4o-mini' }, maxTokens);
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
    // Те же неотключаемые правила формата, что и у follow-up. Здесь цена ошибки
    // даже выше: инвайт режется до 297 знаков, поэтому сочинённое письмо ушло бы
    // человеку оборванным на полуслове.
    { role: 'system', content: `${systemPrompt || DEFAULT_PERSONALIZE_PROMPT}\n${AI_FOLLOWUP_FORMAT_RULES}` },
    { role: 'user', content: userPrompt },
  ];

  // Возвращаем СЫРОЙ ответ модели, без обрезки до 300.
  //
  // Раньше здесь стояло `result.slice(0, 297) + '...'`, и проверка в раннере
  // получала уже укороченный текст. У сочинённого письма подпись и заглушки
  // `[Ваше имя]` всегда в хвосте — обрезка срезала ровно те маркеры, по которым
  // проверка и опознаёт письмо, а правило длины становилось недостижимым:
  // на выходе максимум 300 знаков при нижней границе правила 400. В итоге лиду
  // уходило письмо, оборванное на полуслове, — то самое, что комментарий в
  // раннере обещал не допустить. Обрезку делает раннер после проверки, а
  // окончательный предел всё равно ставит sendInvite.
  return (await makeOpenAiRequest(messages, config, 200)) ?? baseMessage;
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
    // Правила формата дописываются ПОСЛЕ кастомного промпта и намеренно
    // неотключаемы. Кампании передают сюда `ai_prompt_chat` — промпт для
    // ответов в диалоге («отвечай вежливо, договаривайся о звонке»), который
    // затирал DEFAULT_PERSONALIZE_PROMPT вместе с его ограничениями на длину и
    // скобки. 19.08.2026 модель на пустой истории сочинила из 300-знакового
    // шаблона деловое письмо на 691 знак с подписью `[Ваше имя]`, и оно ушло
    // человеку в LinkedIn. См. aiOutputGuard.ts.
    { role: 'system', content: `${systemPrompt || DEFAULT_PERSONALIZE_PROMPT}\n${AI_FOLLOWUP_FORMAT_RULES}` },
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

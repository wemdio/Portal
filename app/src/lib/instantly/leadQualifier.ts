import type { Email } from './types';
import * as instantly from './client';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface QualificationResult {
  isLead: boolean;
  proposalSeen: boolean;
  interestSignals: string[];
  reason: string;
  confidence: number;
  needsReview: boolean;
}

export interface ThreadContext {
  replyEmail: Email;
  threadEmails: Email[];
  lastOutbound: Email | null;
}

// ─── Thread Context Fetcher ──────────────────────────────────────────────────

export async function fetchThreadContext(
  campaignId: string,
  leadEmail: string,
  threadId?: string | null,
): Promise<ThreadContext | null> {
  const params: Record<string, string | number> = {
    campaign_id: campaignId,
    limit: 50,
  };

  const response = await instantly.listEmails(params);
  const allEmails = response.items ?? [];

  let threadEmails: Email[];
  if (threadId) {
    threadEmails = allEmails.filter((e) => e.thread_id === threadId);
  } else {
    threadEmails = allEmails.filter((e) => {
      const from = e.from_address_email?.toLowerCase() ?? '';
      const to = e.to_address_email_list?.toLowerCase() ?? '';
      const target = leadEmail.toLowerCase();
      return from.includes(target) || to.includes(target);
    });
  }

  if (threadEmails.length === 0) return null;

  threadEmails.sort(
    (a, b) =>
      new Date(a.timestamp_email ?? a.timestamp_created ?? 0).getTime() -
      new Date(b.timestamp_email ?? b.timestamp_created ?? 0).getTime(),
  );

  const replyEmail = threadEmails.filter((e) => (e.ue_type ?? 1) === 2).pop();
  if (!replyEmail) return null;

  const replyTs = new Date(
    replyEmail.timestamp_email ?? replyEmail.timestamp_created ?? 0,
  ).getTime();

  const outboundsBefore = threadEmails.filter((e) => {
    const isOurs = (e.ue_type ?? 1) === 1 || (e.ue_type ?? 1) === 3;
    const ts = new Date(e.timestamp_email ?? e.timestamp_created ?? 0).getTime();
    return isOurs && ts < replyTs;
  });

  const lastOutbound = outboundsBefore.length > 0
    ? outboundsBefore[outboundsBefore.length - 1]
    : null;

  return { replyEmail, threadEmails, lastOutbound };
}

// ─── Body Text Extraction ────────────────────────────────────────────────────

export function getBodyText(body: Email['body']): string {
  if (!body) return '';
  if (typeof body === 'string') return body;
  if (body.text) return body.text;
  if (body.html) {
    return body.html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .trim();
  }
  return '';
}

// ─── Rule-Based Pre-Checks ──────────────────────────────────────────────────

const CONTACT_REQUEST_PATTERNS = [
  /(?:подскажите|дайте|скиньте|пришлите)\s+(?:контакт|email|почту|телефон|номер)/i,
  /(?:кто\s+)?(?:ответственн|отвечает\s+за|занимается)/i,
  /(?:на\s+кого\s+выходить|с\s+кем\s+(?:можно\s+)?связаться)/i,
  /(?:переадресуйте|перенаправьте|перешлите)\s+(?:кому\s+)?(?:нужно|следует)/i,
  /(?:контактное\s+лицо|ЛПР|лицо.*принимающ)/i,
];

const AUTO_REPLY_PATTERNS = [
  /(?:автоматическ|automatic|auto[\s-]?reply|out\s+of\s+office|вне\s+офиса)/i,
  /(?:отсутству|в\s+отпуске|нахожусь\s+в\s+(?:командировке|отпуске))/i,
  /(?:unsubscribe|отписаться|больше\s+не\s+пишите|удалите\s+(?:мой|меня))/i,
];

export function isContactRequestOnly(text: string): boolean {
  if (!text || text.length < 10) return false;
  return CONTACT_REQUEST_PATTERNS.some((p) => p.test(text));
}

export function isAutoReplyOrUnsubscribe(text: string): boolean {
  if (!text) return false;
  return AUTO_REPLY_PATTERNS.some((p) => p.test(text));
}

export function isProposalMessage(text: string): boolean {
  if (!text) return false;
  if (text.length < 100) return false;
  if (isContactRequestOnly(text)) return false;
  return true;
}

// ─── AI Classification ──────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Ты — эксперт по квалификации лидов в B2B email-аутриче. Тебе дан контекст переписки: наше последнее исходящее письмо и ответ потенциального клиента.

ЗАДАЧА: определить, является ли ответ квалифицированным лидом.

КРИТЕРИИ ЛИДА (все должны совпасть):
1. Клиент ВИДЕЛ наше развёрнутое предложение (не просто запрос контакта)
2. Клиент проявил ИНТЕРЕС: уточняющие вопросы, запрос цен, предложение позвонить/встретиться, обсуждение условий

НЕ является лидом:
- Ответ на письмо-запрос контакта ответственного (даже если дали телефон/email)
- Автоответ/отпуск
- Отписка/отказ
- Пересылка контакта без ознакомления с предложением
- Нейтральный ответ без интереса к предложению

ФОРМАТ ОТВЕТА (только валидный JSON, без markdown):
{
  "is_lead": true/false,
  "proposal_seen": true/false,
  "interest_signals": ["список конкретных сигналов интереса"],
  "reason": "краткое объяснение на русском, 1-2 предложения",
  "confidence": 0.0-1.0,
  "needs_review": true/false
}`;

interface AIResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export interface ClassifyOptions {
  apiKey: string;
  model?: string;
  maxRetries?: number;
}

const DEFAULT_MODEL = 'policy/gemini-flash';

function buildUserMessage(ctx: ThreadContext): string {
  const lastOutText = ctx.lastOutbound
    ? getBodyText(ctx.lastOutbound.body).slice(0, 3000)
    : '(не найдено)';
  const replyText = getBodyText(ctx.replyEmail.body).slice(0, 3000);
  const stepCount = ctx.threadEmails.filter((e) => (e.ue_type ?? 1) === 1).length;

  return `НАШЕ ПОСЛЕДНЕЕ ИСХОДЯЩЕЕ ПИСЬМО (шаг ${stepCount} кампании):
---
${lastOutText}
---

ОТВЕТ ПОТЕНЦИАЛЬНОГО КЛИЕНТА:
Тема: ${ctx.replyEmail.subject ?? '(без темы)'}
---
${replyText}
---

Определи, является ли этот ответ квалифицированным лидом.`;
}

function parseAIResult(content: string): QualificationResult {
  const trimmed = content.trim();
  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('AI вернул некорректный JSON');
    parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  }

  return {
    isLead: Boolean(parsed.is_lead),
    proposalSeen: Boolean(parsed.proposal_seen),
    interestSignals: Array.isArray(parsed.interest_signals)
      ? (parsed.interest_signals as unknown[]).map(String)
      : [],
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    confidence:
      typeof parsed.confidence === 'number'
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.5,
    needsReview: Boolean(parsed.needs_review),
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function classifyWithAI(
  ctx: ThreadContext,
  options: ClassifyOptions,
): Promise<QualificationResult> {
  const { apiKey, model = DEFAULT_MODEL, maxRetries = 2 } = options;
  const userMessage = buildUserMessage(ctx);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response;
    try {
      response = await fetch('https://router.requesty.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://portal.app',
          'X-Title': 'Portal - Instantly Lead Qualification',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMessage },
          ],
          temperature: 0.1,
          max_tokens: 800,
          response_format: { type: 'json_object' },
        }),
      });
    } catch (err) {
      if (attempt < maxRetries) {
        await sleep(1500 * Math.pow(2, attempt));
        continue;
      }
      throw new Error(
        `Network error: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }

    if (response.ok) {
      const data = (await response.json()) as AIResponse;
      const content = data.choices?.[0]?.message?.content?.trim() ?? '';
      return parseAIResult(content);
    }

    if ([502, 503, 504].includes(response.status) && attempt < maxRetries) {
      await sleep(1500 * Math.pow(2, attempt));
      continue;
    }

    const text = await response.text().catch(() => '');
    throw new Error(`AI API ${response.status}: ${text.slice(0, 200)}`);
  }

  throw new Error('AI classification failed after retries');
}

// ─── Main Qualification Pipeline ─────────────────────────────────────────────

export async function qualifyReply(
  campaignId: string,
  leadEmail: string,
  threadId: string | null | undefined,
  aiOptions: ClassifyOptions,
): Promise<
  QualificationResult & {
    threadContext: ThreadContext | null;
  }
> {
  const ctx = await fetchThreadContext(campaignId, leadEmail, threadId);
  if (!ctx) {
    return {
      isLead: false,
      proposalSeen: false,
      interestSignals: [],
      reason: 'Не удалось восстановить контекст переписки',
      confidence: 0,
      needsReview: true,
      threadContext: null,
    };
  }

  const replyText = getBodyText(ctx.replyEmail.body);

  if (isAutoReplyOrUnsubscribe(replyText)) {
    return {
      isLead: false,
      proposalSeen: false,
      interestSignals: [],
      reason: 'Автоответ или отписка',
      confidence: 0.95,
      needsReview: false,
      threadContext: ctx,
    };
  }

  if (!ctx.lastOutbound) {
    return {
      isLead: false,
      proposalSeen: false,
      interestSignals: [],
      reason: 'Не найдено исходящее письмо перед ответом',
      confidence: 0.7,
      needsReview: true,
      threadContext: ctx,
    };
  }

  const outboundText = getBodyText(ctx.lastOutbound.body);

  if (isContactRequestOnly(outboundText) && !isProposalMessage(outboundText)) {
    return {
      isLead: false,
      proposalSeen: false,
      interestSignals: [],
      reason: 'Ответ на запрос контакта — клиент не видел предложение',
      confidence: 0.9,
      needsReview: false,
      threadContext: ctx,
    };
  }

  const aiResult = await classifyWithAI(ctx, aiOptions);
  return { ...aiResult, threadContext: ctx };
}

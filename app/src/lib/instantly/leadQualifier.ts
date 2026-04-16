import type { Email } from './types';
import * as instantly from './client';
import { supabaseInstantly } from '@/lib/supabaseInstantly';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface QualificationResult {
  isLead: boolean;
  proposalSeen: boolean;
  interestSignals: string[];
  reason: string;
  confidence: number;
  needsReview: boolean;
  objectionHandleable: boolean;
  objectionDraft: string | null;
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
  let allEmails: Email[] = [];

  // Fetch emails for this specific lead using the search parameter
  // (lead_id filter on /emails does not work correctly in Instantly API v2)
  try {
    const res = await instantly.listEmails({
      campaign_id: campaignId,
      search: leadEmail,
      limit: 100,
    });
    allEmails = res.items ?? [];
  } catch {
    // fall through to campaign-wide fetch
  }

  // Fallback: fetch recent campaign emails if search returned nothing
  if (allEmails.length === 0) {
    try {
      const response = await instantly.listEmails({
        campaign_id: campaignId,
        limit: 100,
      });
      allEmails = response.items ?? [];
    } catch {
      return null;
    }
  }

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
  return text.length >= 200;
}

// ─── AI Classification ──────────────────────────────────────────────────────

function buildSystemPrompt(briefText?: string | null): string {
  const briefSection = briefText
    ? `\n\nКОНТЕКСТ ПРЕДЛОЖЕНИЯ (бриф клиента):\n---\n${briefText.slice(0, 4000)}\n---\nИспользуй этот контекст для определения возражений и генерации черновика ответа.`
    : '';

  return `Ты — эксперт по квалификации лидов в B2B email-аутриче. Тебе дан контекст переписки: наше последнее исходящее письмо и ответ потенциального клиента.${briefSection}

ЗАДАЧА: определить категорию ответа.

КАТЕГОРИИ:
1. КВАЛИФИЦИРОВАННЫЙ ЛИД — клиент видел предложение И проявил интерес (уточняющие вопросы, запрос цен, предложение позвонить/встретиться, обсуждение условий)
2. МОЖНО ОБРАБОТАТЬ ВОЗРАЖЕНИЕ — клиент видел предложение, но выразил сомнение, возражение или мягкий отказ, который можно обработать аргументами (например: "дорого", "не сейчас", "у нас уже есть подрядчик", "не уверен что нам это нужно"). НЕ прямой категоричный отказ.
3. НЕ ЛИД — автоответ, отписка, прямой отказ, ответ на запрос контакта без ознакомления с предложением, нейтральный ответ

КРИТЕРИИ ЛИДА (все должны совпасть):
1. Клиент ВИДЕЛ наше развёрнутое предложение (не просто запрос контакта)
2. Клиент проявил ИНТЕРЕС: уточняющие вопросы, запрос цен, предложение позвонить/встретиться, обсуждение условий

КРИТЕРИИ ВОЗРАЖЕНИЯ:
- Клиент видел предложение (proposal_seen=true)
- Ответ содержит возражение/сомнение, но НЕ категоричный отказ
- Можно сформулировать аргумент на основе предложения${briefText ? ' и контекста брифа' : ''}

ВАЖНО — как определить что клиент ВИДЕЛ предложение (proposal_seen=true):
- Наше последнее исходящее письмо содержит развёрнутое предложение (не просто запрос контакта)
- ИЛИ в ответе клиента ЦИТИРУЕТСЯ наше предложение (текст после ">" или ниже строки "On ... wrote:" / даты отправки)
- ИЛИ клиент ссылается на содержание предложения (цены, услуги, условия)
- Если клиент спрашивает "сколько стоит?", "пришлите КП", запрашивает цены/условия — он ВИДЕЛ предложение и проявил ИНТЕРЕС, это ЛИД
- Запрос контакта ответственного — это НЕ предложение. Но если после запроса контакта было отправлено предложение — смотри на последнее письмо

НЕ является лидом и НЕ возражение:
- Автоответ/отпуск
- Отписка/категоричный отказ ("нас это не интересует", "не пишите больше")
- Пересылка контакта без ознакомления с предложением
- Ответ ТОЛЬКО на запрос контакта (без предложения) с просто контактными данными

ФОРМАТ ОТВЕТА (только валидный JSON, без markdown):
{
  "is_lead": true/false,
  "proposal_seen": true/false,
  "interest_signals": ["список конкретных сигналов интереса"],
  "reason": "краткое объяснение на русском, 1-2 предложения",
  "confidence": 0.0-1.0,
  "needs_review": true/false,
  "objection_handleable": true/false,
  "objection_draft": "черновик ответа на возражение (только если objection_handleable=true, иначе null)"
}`;
}

interface AIResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export interface ClassifyOptions {
  apiKey: string;
  model?: string;
  maxRetries?: number;
  briefText?: string | null;
}

const DEFAULT_MODEL = 'policy/gemini-flash';

export async function fetchBriefByCampaign(campaignId: string): Promise<string | null> {
  if (!supabaseInstantly) return null;

  const { data } = await supabaseInstantly
    .from('instantly_brief_campaigns')
    .select('brief_id, instantly_briefs(brief_text)')
    .eq('campaign_id', campaignId)
    .limit(1)
    .single();

  if (!data) return null;

  const briefs = data.instantly_briefs as unknown as { brief_text: string } | null;
  return briefs?.brief_text ?? null;
}

function extractQuotedText(replyText: string): string | null {
  const lines = replyText.split('\n');
  const quotedLines: string[] = [];
  let inQuote = false;

  for (const line of lines) {
    if (line.startsWith('>')) {
      inQuote = true;
      quotedLines.push(line.replace(/^>\s*/, ''));
    } else if (inQuote && line.trim() === '') {
      quotedLines.push('');
    } else if (inQuote) {
      break;
    }
  }

  const quoted = quotedLines.join('\n').trim();
  return quoted.length > 50 ? quoted : null;
}

function buildUserMessage(ctx: ThreadContext): string {
  const lastOutText = ctx.lastOutbound
    ? getBodyText(ctx.lastOutbound.body).slice(0, 3000)
    : '(не найдено)';
  const replyText = getBodyText(ctx.replyEmail.body).slice(0, 3000);
  const stepCount = ctx.threadEmails.filter((e) => (e.ue_type ?? 1) === 1).length;

  const hasQuotedContent = replyText.includes('>') || /(?:On|В|от)\s+.+(?:wrote|написал|:$)/im.test(replyText);
  const quotedText = hasQuotedContent ? extractQuotedText(replyText) : null;

  let outboundSection: string;
  if (ctx.lastOutbound) {
    outboundSection = `НАШЕ ПОСЛЕДНЕЕ ИСХОДЯЩЕЕ ПИСЬМО (шаг ${stepCount} кампании):
---
${lastOutText}
---`;
  } else if (quotedText) {
    outboundSection = `НАШЕ ПОСЛЕДНЕЕ ИСХОДЯЩЕЕ ПИСЬМО (извлечено из цитаты в ответе клиента):
---
${quotedText.slice(0, 3000)}
---
ВАЖНО: Исходящее письмо не найдено в API, но клиент процитировал его в ответе — значит он его ПОЛУЧИЛ и ВИДЕЛ (proposal_seen=true).`;
  } else {
    outboundSection = `НАШЕ ПОСЛЕДНЕЕ ИСХОДЯЩЕЕ ПИСЬМО (шаг ${stepCount} кампании):
---
(не найдено)
---`;
  }

  let quotedHint = '';
  if (hasQuotedContent) {
    quotedHint = '\nОБРАТИ ВНИМАНИЕ: В ответе клиента есть цитированный текст (строки с ">" или блок ниже разделителя). Если цитируется наше предложение — клиент его ВИДЕЛ (proposal_seen=true).';
  }

  return `${outboundSection}

ОТВЕТ ПОТЕНЦИАЛЬНОГО КЛИЕНТА:
Тема: ${ctx.replyEmail.subject ?? '(без темы)'}
---
${replyText}
---
${quotedHint}
Определи категорию ответа, учитывая ВСЁ содержание письма, включая цитированный текст.`;
}

function parseAIResult(content: string): QualificationResult {
  const trimmed = content.trim();
  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const codeBlock = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = codeBlock ? codeBlock[1].trim() : trimmed;

    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.error('[LeadQualifier] Cannot parse AI response:', trimmed.slice(0, 500));
        return {
          isLead: false,
          proposalSeen: false,
          interestSignals: [],
          reason: `AI вернул некорректный JSON: ${trimmed.slice(0, 150)}`,
          confidence: 0,
          needsReview: true,
          objectionHandleable: false,
          objectionDraft: null,
        };
      }
      parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    }
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
    objectionHandleable: Boolean(parsed.objection_handleable),
    objectionDraft:
      typeof parsed.objection_draft === 'string' && parsed.objection_draft
        ? parsed.objection_draft
        : null,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function classifyWithAI(
  ctx: ThreadContext,
  options: ClassifyOptions,
): Promise<QualificationResult> {
  const { apiKey, model = DEFAULT_MODEL, maxRetries = 2, briefText } = options;
  const userMessage = buildUserMessage(ctx);
  const systemPrompt = buildSystemPrompt(briefText);

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
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
          temperature: 0.1,
          max_tokens: 1500,
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
      if (!content && attempt < maxRetries) {
        console.warn('[LeadQualifier] Empty AI response, retrying...');
        await sleep(1500 * Math.pow(2, attempt));
        continue;
      }
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
      objectionHandleable: false,
      objectionDraft: null,
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
      objectionHandleable: false,
      objectionDraft: null,
      threadContext: ctx,
    };
  }

  if (ctx.lastOutbound) {
    const outboundText = getBodyText(ctx.lastOutbound.body);
    const replyHasQuotes = replyText.includes('>') || /(?:On|В|от)\s+.+(?:wrote|написал|:$)/im.test(replyText);
    if (isContactRequestOnly(outboundText) && !isProposalMessage(outboundText) && !replyHasQuotes) {
      return {
        isLead: false,
        proposalSeen: false,
        interestSignals: [],
        reason: 'Ответ на запрос контакта — клиент не видел предложение',
        confidence: 0.9,
        needsReview: false,
        objectionHandleable: false,
        objectionDraft: null,
        threadContext: ctx,
      };
    }
  }

  let briefText = aiOptions.briefText ?? null;
  if (briefText === null || briefText === undefined) {
    briefText = await fetchBriefByCampaign(campaignId);
  }

  const aiResult = await classifyWithAI(ctx, { ...aiOptions, briefText });
  return { ...aiResult, threadContext: ctx };
}

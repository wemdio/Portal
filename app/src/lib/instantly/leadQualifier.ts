import type { Email } from './types';
import * as instantly from './client';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { supabaseAdmin as supabaseMain } from '@/lib/supabaseAdmin';

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
  /**
   * Ящики (eaccount, lowercase), с которых кампания слала письма — собраны из
   * ВСЕХ писем, полученных при восстановлении контекста (search + campaign-wide
   * fallback), без дополнительных API-вызовов. Нужны кросс-клиентскому guard'у
   * воркера: threadEmails отфильтрованы по треду/лиду и для «слепых» писем
   * (Instantly приклеил чужое письмо по домену) часто не содержат ни одного
   * нашего исходящего — а campaign-wide страница содержит.
   */
  campaignOutboundMailboxes?: string[];
}

// ─── Thread Context Fetcher ──────────────────────────────────────────────────

export async function fetchThreadContext(
  campaignId: string,
  leadEmail: string,
  threadId?: string | null,
  accountId?: string,
): Promise<ThreadContext | null> {
  let allEmails: Email[] = [];

  // Fetch emails for this specific lead using the search parameter
  // (lead_id filter on /emails does not work correctly in Instantly API v2)
  try {
    const res = await instantly.listEmails({
      campaign_id: campaignId,
      search: leadEmail,
      limit: 100,
    }, { accountId });
    allEmails = res.items ?? [];
  } catch {
    // fall through to campaign-wide fetch
  }

  // The search=leadEmail query reliably returns the lead's INBOUND reply but
  // often NOT our sends — Instantly's search matches the lead in from_address
  // (their reply), not the to_address of our campaign sends. (And lead=email
  // returns nothing at all in v2 — that's why search is used in the first place.)
  // So when the search result contains no outbound of ours, ALSO pull the
  // campaign-wide page and merge it in. This recovers the ~18-23% of replies
  // where our last outbound was otherwise lost (→ proposal_seen wrongly false →
  // the AI over-cautiously under-rates real leads). Verified against prod data.
  // Fires only on that minority of replies, so no material extra Instantly load.
  const hasOutbound = (list: Email[]): boolean =>
    list.some((e) => (e.ue_type ?? 1) === 1 || (e.ue_type ?? 1) === 3);

  if (allEmails.length === 0 || !hasOutbound(allEmails)) {
    try {
      const response = await instantly.listEmails({
        campaign_id: campaignId,
        limit: 100,
      }, { accountId });
      const seen = new Set(allEmails.map((e) => e.id));
      for (const e of response.items ?? []) {
        if (!e.id || !seen.has(e.id)) allEmails.push(e);
      }
    } catch {
      if (allEmails.length === 0) return null;
    }
  }

  const target = leadEmail.toLowerCase();
  const matchesLead = (e: Email): boolean => {
    const from = e.from_address_email?.toLowerCase() ?? '';
    const to = e.to_address_email_list?.toLowerCase() ?? '';
    return from.includes(target) || to.includes(target);
  };

  const byTs = (a: Email, b: Email) =>
    new Date(a.timestamp_email ?? a.timestamp_created ?? 0).getTime() -
    new Date(b.timestamp_email ?? b.timestamp_created ?? 0).getTime();

  // Reply scope — PINNED to the dispatched thread. THE reply is always chosen
  // from here, so a multi-thread lead can never shift the qualified reply to a
  // different one (the row's instantly_email_id/thread_id and the analyzed
  // reply_body stay in sync).
  const replyScope = threadId
    ? allEmails.filter((e) => e.thread_id === threadId)
    : allEmails.filter(matchesLead);

  if (replyScope.length === 0) return null;
  replyScope.sort(byTs);

  const replyEmail = replyScope.filter((e) => (e.ue_type ?? 1) === 2).pop();
  if (!replyEmail) return null;

  const replyTs = new Date(
    replyEmail.timestamp_email ?? replyEmail.timestamp_created ?? 0,
  ).getTime();

  // Outbound scope — same as replyScope, but widened to the lead's other threads
  // ONLY when the reply's own thread carries no send of ours (Instantly sometimes
  // files our send under a sibling thread_id). Used ONLY to recover lastOutbound;
  // it never affects which reply is selected. No extra API call (in-memory).
  const outboundScope =
    threadId && !hasOutbound(replyScope) ? allEmails.filter(matchesLead) : replyScope;

  const outboundsBefore = outboundScope
    .filter((e) => {
      const isOurs = (e.ue_type ?? 1) === 1 || (e.ue_type ?? 1) === 3;
      const ts = new Date(e.timestamp_email ?? e.timestamp_created ?? 0).getTime();
      return isOurs && ts < replyTs;
    })
    .sort(byTs);

  const lastOutbound = outboundsBefore.length > 0
    ? outboundsBefore[outboundsBefore.length - 1]
    : null;

  // Ящики кампании из всего скачанного (до тред/лид-фильтров) — in-memory.
  const campaignOutboundMailboxes = [
    ...new Set(
      allEmails
        .filter((e) => (e.ue_type ?? 1) === 1 || (e.ue_type ?? 1) === 3)
        .map((e) => (e.eaccount ?? '').trim().toLowerCase())
        .filter(Boolean),
    ),
  ];

  return { replyEmail, threadEmails: outboundScope, lastOutbound, campaignOutboundMailboxes };
}

// ─── Body Text Extraction ────────────────────────────────────────────────────

const NAMED_HTML_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  laquo: '«',
  raquo: '»',
  mdash: '—',
  ndash: '–',
  hellip: '…',
};

function decodeCodePoint(code: number, fallback: string): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : fallback;
}

export function getBodyText(body: Email['body']): string {
  if (!body) return '';
  if (typeof body === 'string') return body;
  if (body.text) return body.text;
  if (body.html) {
    return (
      body.html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
        .replace(/<[^>]+>/g, '')
        // Числовые сущности (&#1059; / &#x442;): mail.ru и часть клиентов шлют
        // html-only письма со ВСЕЙ кириллицей в таком виде — без декода в
        // reply_body/алертах «каша» из кодов вместо текста.
        .replace(/&#(\d+);/g, (m, dec: string) => decodeCodePoint(Number(dec), m))
        .replace(/&#x([0-9a-f]+);/gi, (m, hex: string) => decodeCodePoint(parseInt(hex, 16), m))
        .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_HTML_ENTITIES[name.toLowerCase()] ?? m)
        // &amp; последним — чтобы двойное кодирование (&amp;lt;) не превращалось в "<"
        .replace(/&amp;/gi, '&')
        .trim()
    );
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
  // Смена/закрытие почтового ящика: формальные уведомления «этот адрес больше
  // не работает, пишите на новый / вот контакты сотрудников». Список новых
  // контактов ИИ вероятностно читал как интерес («предоставили прямого HR») —
  // ложный лид stroytim_plus 29.06 (баг №1 от спеца). Маркеры сознательно
  // КАНЦЕЛЯРСКИЕ: живое «вышлите КП на другой адрес» (реальный интерес) сюда
  // не попадает — его по-прежнему решает ИИ.
  // NB: JS `\w` не матчит кириллицу — суффиксы через [а-яё]; в зазоре
  // разрешены точки (внутри адреса вида mail.ru), перенос строки — граница.
  /(?:почт|адрес|ящик|mailbox|e-?mail)[^\n]{0,60}(?:прекраща|прекрати|не\s+(?:обслуживается|используется|действует|работает)|is\s+no\s+longer)/i,
  /(?:смен[аеуы]\s+(?:адреса|почты|электронной\s+почты)|официальн[а-яё]+\s+почт[а-яё]*\s+компании|просим\s+(?:вас\s+)?(?:вести\s+переписку|направлять\s+(?:письма|корреспонденцию|обращения)))/i,
];

export function isContactRequestOnly(text: string): boolean {
  if (!text || text.length < 10) return false;
  return CONTACT_REQUEST_PATTERNS.some((p) => p.test(text));
}

export function isAutoReplyOrUnsubscribe(text: string): boolean {
  if (!text) return false;
  return AUTO_REPLY_PATTERNS.some((p) => p.test(text));
}

const JUNK_REPLY_EXACT = new Set([
  'нет', 'no', 'не интересует', 'не актуально', 'не надо', 'спасибо не надо',
  'ок', 'ok', 'ясно', 'понятно', 'спс', 'спасибо', 'thanks', 'благодарю',
  '+', '-', '.', '..', '...', '?', '!', 'да', 'yes', 'угу', 'ага',
]);

export function isJunkReply(text: string): boolean {
  if (!text) return true;
  const normalized = text.trim().toLowerCase().replace(/[.!?,;:«»"'`\s]+$/g, '').trim();
  if (normalized.length < 3) return true;
  if (normalized.length > 50) return false;
  return JUNK_REPLY_EXACT.has(normalized);
}

export function isProposalMessage(text: string): boolean {
  if (!text) return false;
  return text.length >= 200;
}

// ─── AI Classification ──────────────────────────────────────────────────────

function buildSystemPrompt(briefText?: string | null, leadCriteria?: string | null): string {
  const briefSection = briefText
    ? `\n\nКОНТЕКСТ ПРЕДЛОЖЕНИЯ (бриф клиента):\n---\n${briefText.slice(0, 2000)}\n---\nИспользуй этот контекст для определения возражений и генерации черновика ответа.`
    : '';

  // Пер-проектное определение лида (projects.lead_criteria): команда проекта
  // сама решает, что считать лидом. Нужно контакт-запросным кампаниям (шаг 1 —
  // «кто отвечает за X?»): дефолтный критерий «видел развёрнутое предложение»
  // структурно глушит их горячие ответы («можете меня набрать в 14-15»).
  // Блок ставится ПЕРЕД стандартными критериями и объявлен приоритетным.
  const criteriaSection = leadCriteria?.trim()
    ? `\n\nОПРЕДЕЛЕНИЕ ЛИДА ДЛЯ ЭТОГО ПРОЕКТА (задано командой проекта — при ЛЮБОМ противоречии со стандартными критериями ниже ПРИОРИТЕТ у этого определения):\n---\n${leadCriteria.trim().slice(0, 2000)}\n---`
    : '';

  return `Ты — эксперт по квалификации лидов в B2B email-аутриче. Тебе дан контекст переписки: наше последнее исходящее письмо и ответ потенциального клиента.${briefSection}${criteriaSection}

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

ВАЖНО — НЕ путай дежурные контакты с интересом:
- Телефон/адрес/сайт в подписи или в шаблонном подтверждении ("Спасибо за сообщение", "Ваше письмо получено", "свяжемся / предоставим ответ", "звоните по любым вопросам") — это АВТООТВЕТ-подтверждение получения, а НЕ интерес. Само по себе это is_lead=false, proposal_seen=false.
- "Предложение позвонить/встретиться" считается сигналом интереса ТОЛЬКО если клиент явно зовёт обсудить НАШЕ предложение ("давайте созвонимся по вашему КП", "наберите по поводу внедрения"), а не просто оставил дежурный контакт в подписи.
- Вежливость ("спасибо", "благодарю за информацию") без вопросов, запроса цен или обсуждения условий — НЕ лид.

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
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string };
  }>;
}

export interface ClassifyOptions {
  apiKey: string;
  model?: string;
  maxRetries?: number;
  briefText?: string | null;
  /**
   * Пер-проектное определение лида (projects.lead_criteria). Непусто →
   * в промпт вставляется приоритетный блок критериев, а детерминированный
   * ранний выход «ответ на запрос контакта = не лид» отключается (иначе он
   * убил бы кастомное определение до вызова ИИ).
   */
  leadCriteria?: string | null;
  /**
   * Уже полученный контекст переписки. Если передан — qualifyReply НЕ дёргает
   * Instantly /emails за тредом, а использует его. Нужно real-time-разгребателю
   * очереди вебхуков: он фетчит тред один раз (проверка готовности + id письма) и
   * переиспользует здесь, чтобы не делать второй вызов Instantly на тот же ответ.
   */
  prefetchedContext?: ThreadContext | null;
}

const DEFAULT_MODEL = 'policy/gemini-flash';
const DEFAULT_MAX_TOKENS = 2000;

function envNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? String(fallback));
  return Number.isFinite(raw) ? raw : fallback;
}

/**
 * Fetch brief text for a campaign.
 * Source: campaign → project (via project_instantly_campaigns) → projects.brief_text.
 * Falls back to old instantly_brief_campaigns → instantly_briefs if project brief not found.
 */
export async function fetchBriefByCampaign(campaignId: string): Promise<string | null> {
  if (!supabaseInstantly) return null;

  // Primary: get brief from project linked to this campaign
  if (supabaseMain) {
    const { data: periodLink } = await supabaseInstantly
      .from('project_period_instantly_campaigns')
      .select('project_id')
      .eq('campaign_id', campaignId)
      .limit(1)
      .maybeSingle();

    const { data: legacyLink } = periodLink?.project_id
      ? { data: null }
      : await supabaseInstantly
      .from('project_instantly_campaigns')
      .select('project_id')
      .eq('campaign_id', campaignId)
      .limit(1)
      .maybeSingle();

    const link = periodLink?.project_id ? periodLink : legacyLink;
    if (link?.project_id) {
      const { data: project } = await supabaseMain
        .from('projects')
        .select('brief_text')
        .eq('id', link.project_id)
        .maybeSingle();

      if (project?.brief_text) return project.brief_text as string;
    }
  }

  // Fallback: old instantly_briefs table (for campaigns not yet linked to projects)
  const { data } = await supabaseInstantly
    .from('instantly_brief_campaigns')
    .select('brief_id, instantly_briefs(brief_text)')
    .eq('campaign_id', campaignId)
    .limit(1)
    .maybeSingle();

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

/**
 * Чинит самую частую причину «Bad control character in string literal in JSON»
 * — AI вкладывает в строку реальный \n / \r / \t / null-byte вместо их
 * escape-форм (`\\n`, `\\r`, `\\t`). Стандартный JSON.parse такие символы
 * внутри значения "..." считает невалидными и падает.
 *
 * Стейт-машина: проходим посимвольно, отслеживаем «мы внутри строки или нет»,
 * экранируем control characters только внутри строк. Структурные пробелы и
 * переводы строк между ключами/значениями не трогаем.
 *
 * Также удаляем редко-встречающиеся управляющие байты (DEL, U+007F и т.п.),
 * которые в любом случае ломают и parse, и валидацию.
 */
function sanitizeAIJsonString(raw: string): string {
  // Убираем «совсем плохие» control bytes (кроме \t \n \r — их обработает ниже).
  // Через RegExp+строку с \u-escape — control chars в /.../ литерале
  // TypeScript парсит как «Unterminated regular expression literal».
  const stripCtrl = new RegExp(
    '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]',
    'g',
  );
  const stripped = raw.replace(stripCtrl, '');

  let inString = false;
  let escapeNext = false;
  let out = '';
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (escapeNext) {
      out += ch;
      escapeNext = false;
      continue;
    }
    if (inString && ch === '\\') {
      out += ch;
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString) {
      if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else out += ch;
    } else {
      out += ch;
    }
  }
  return out;
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
        console.error('[LeadQualifier] Cannot find JSON object in AI response:', trimmed.slice(0, 500));
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
      try {
        parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      } catch {
        // Финальная попытка: санитизация управляющих символов внутри строк.
        // Случай hello@igroup.dev (14 мая 2026): AI вернул JSON с
        // неэкранированным \n внутри "reason" — JSON.parse падал с
        // «Bad control character at position 571». Раньше лид терялся.
        try {
          parsed = JSON.parse(sanitizeAIJsonString(jsonMatch[0])) as Record<string, unknown>;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(
            '[LeadQualifier] All parse attempts failed:',
            errMsg,
            '\nRaw AI response (first 800 chars):\n',
            trimmed.slice(0, 800),
          );
          return {
            isLead: false,
            proposalSeen: false,
            interestSignals: [],
            reason: `AI вернул JSON с управляющими символами: ${errMsg.slice(0, 150)}`,
            confidence: 0,
            needsReview: true,
            objectionHandleable: false,
            objectionDraft: null,
          };
        }
      }
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

/** Внутренние функции для unit-тестов парсера. Не использовать в продакшен-коде. */
export const _private = {
  sanitizeAIJsonString,
  parseAIResult,
};

export async function classifyWithAI(
  ctx: ThreadContext,
  options: ClassifyOptions,
): Promise<QualificationResult> {
  const { apiKey, model = DEFAULT_MODEL, maxRetries = 2, briefText, leadCriteria } = options;
  const userMessage = buildUserMessage(ctx);
  const systemPrompt = buildSystemPrompt(briefText, leadCriteria);
  const maxTokens = Math.max(
    1000,
    envNumber('INSTANTLY_LEAD_QUAL_MAX_TOKENS', DEFAULT_MAX_TOKENS),
  );

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
          max_tokens: maxTokens,
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
      const choice = data.choices?.[0];
      const content = choice?.message?.content?.trim() ?? '';
      if (choice?.finish_reason === 'length' && attempt < maxRetries) {
        console.warn('[LeadQualifier] AI response hit max_tokens, retrying...');
        await sleep(1500 * Math.pow(2, attempt));
        continue;
      }
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
  accountId?: string,
): Promise<
  QualificationResult & {
    threadContext: ThreadContext | null;
  }
> {
  // `!== undefined`, НЕ `??`: null означает «вызывающий УЖЕ фетчил контекст и
  // его нет» — рефетч тут удваивал бы вызовы /emails ровно на деградирующем
  // Instantly (общий лимит воркспейса, инцидент 22 мая). undefined = «не
  // префетчили» → фетчим сами.
  const ctx =
    aiOptions.prefetchedContext !== undefined
      ? aiOptions.prefetchedContext
      : await fetchThreadContext(campaignId, leadEmail, threadId, accountId);
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

  if (isJunkReply(replyText)) {
    return {
      isLead: false,
      proposalSeen: false,
      interestSignals: [],
      reason: 'Слишком короткий или неинформативный ответ',
      confidence: 0.9,
      needsReview: false,
      objectionHandleable: false,
      objectionDraft: null,
      threadContext: ctx,
    };
  }

  // При кастомном определении лида (projects.lead_criteria) ранний выход
  // «ответ на запрос контакта = не лид» отключён: он зашивает дефолтный
  // критерий proposal_seen и убил бы кастом до вызова ИИ (кейс ADE 13.07:
  // «можете меня набрать в 14-15» на контакт-запросе Ritso).
  if (ctx.lastOutbound && !aiOptions.leadCriteria?.trim()) {
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

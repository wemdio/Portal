/**
 * Шаблоны цепочек английского автоаутрича: Gemini 3.1 Pro пишет цепочку один
 * раз на оффер запуска, под компанию подставляются проверенные факты (спека
 * 2026-09-26-outreach-to-sender-design.md §4). Оффер — тип главного повода:
 * найм в sales/GTM, YC, запуск продукта, стек продаж (без повода — none).
 * Устроено как у русского аутрича (polzaRuOutreach/letters/templateWriter.ts).
 *
 * Лениво: шаблон оффера пишется, когда до писем дошла первая компания этого
 * оффера. Параллельные компании оффера ждут один и тот же промис
 * (createChainTemplates), а между процессами — воркер и роут «Переписать
 * цепочку» — строку в polza_chain_templates сначала занимают (status
 * pending), и только занявший платит писателю. Так за один оффер не платим
 * дважды.
 *
 * Вход писателю — по-английски, письма английские: суть оффера и цель каждого
 * из четырёх писем, образец — нынешняя цепочка CEO (buildLetters), собранная
 * на плейсхолдерах, примеры фразы-повода и правила гардов. Ответ проверяет
 * guardTemplate; провал — один повтор с замечаниями, снова провал — шаблон
 * failed, компании оффера уходят на ручную проверку (template_failed), а
 * «Переписать цепочку» пробует заново.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { callOutreachJson, type OutreachLlmUsage } from '@/lib/outreachLlm/client';
import { BudgetExceededError, LlmAuthError, LlmCallError } from '@/lib/outreachLlm/context';
import {
  buildLetters,
  caseSentence,
  describeTemplateFlag,
  guardTemplate,
  normalizeSampleRange,
  segmentsBlock,
  triggerPhrase,
  triggerShort,
} from './buildLetters';
import type { EnCase } from './caseRouter';
import type { Trigger } from './leadScore';
import {
  POLZA_OUTREACH_DEFAULT_SIGNATURE,
  POLZA_TEMPLATE_PLACEHOLDERS,
  polzaTemplatePlaceholdersFor,
  type PolzaChainTemplateLetters,
  type PolzaOfferKey,
} from './types';

const P = POLZA_TEMPLATE_PLACEHOLDERS;
const TABLE = 'polza_chain_templates';
const LANG = 'en';
const ROW_COLUMNS = 'id,offer_key,status,letters,qa_flags,model,cost_usd,attempt,error,updated_at';

/** Первая попытка и одна повторная — с замечаниями автопроверки. */
const MAX_WRITER_ATTEMPTS = 2;
/**
 * Лимит токенов ответа писателя. Gemini считает в нём и скрытые рассуждения:
 * шесть писем шаблона с рассуждениями в 8000 по умолчанию могут не влезть, а
 * обрезанный ответ оплачен и выброшен. Платим только за написанное, поэтому
 * запас сверху ничего не стоит; обрезанный всё же — клиент повторит с 16000.
 */
const WRITER_MAX_TOKENS = 12_000;
/**
 * Срок одного вызова писателя в воркере — со всеми повторами транспорта.
 * Gemini отвечает за 20–90 с; без срока зависший Requesty держал бы компании
 * оффера до 15 минут.
 */
export const WORKER_WRITER_TIMEOUT_MS = 300_000;
/**
 * В роуте «Переписать цепочку» пользователь ждёт ответа на экране. У русского
 * аутрича здесь было 60 с, но Gemini 3.1 Pro с рассуждениями на шесть писем
 * шаблона нередко думает дольше минуты — в 60 с вызов обрывался бы оплаченным
 * и без ответа. Поэтому 100 с на вызов и 200 с на обе попытки вместе: с
 * пересборкой писем роут укладывается в maxDuration 280 с и отвечает раньше,
 * чем nginx (300 с) оборвёт запрос.
 */
export const ROUTE_WRITER_TIMEOUT_MS = 100_000;
export const ROUTE_WRITER_TOTAL_MS = 200_000;
/** Повтор с замечаниями, на который осталось меньше этого, не начинаем: он не успеет. */
const MIN_RETRY_MS = 60_000;
/**
 * Строка pending дольше этого — занявший процесс умер (перезапуск воркера или
 * Next посреди записи): её можно занять заново. Больше двух вызовов писателя
 * в воркере (2 × 5 мин).
 */
export const PENDING_STALE_MS = 15 * 60_000;
const POLL_MS = 5_000;

/** Начало error у шаблона, который не написан, потому что модель не ответила (а не лимит, ключ или остановка). */
const AI_FAILED_PREFIX = 'ИИ не ответил: ';

export interface ChainTemplate {
  id: string;
  offer: PolzaOfferKey;
  status: 'ok' | 'failed';
  /** Письма шаблона; у failed — последний вариант писателя (на экран), если он был. */
  letters: PolzaChainTemplateLetters | null;
  qaFlags: string[];
  /** Почему шаблона нет совсем: ИИ не ответил, лимит на ИИ, ключ, остановка запуска. */
  error: string | null;
  /**
   * Шаблона нет, потому что модель не ответила (сеть, 5xx, битый JSON после
   * повторов), — не приговор офферу: раннер один раз пробует его заново в
   * следующей волне. Провал проверки — ответ писателя, его не повторяем.
   */
  aiFailed: boolean;
  model: string | null;
  /** Все попытки шаблона, включая прошлые «Переписать цепочку». */
  costUsd: number;
  /** Сколько раз писатель писал этот шаблон. */
  attempt: number;
}

export interface TemplateWriterDeps {
  /** Воркер — service role; роут — клиент пользователя (RLS: его запуски). */
  db: SupabaseClient;
  jobId: string;
  /** Срок одного вызова писателя (со всеми повторами транспорта). */
  writerTimeoutMs: number;
  /** Срок обеих попыток вместе; нет — у каждой попытки свой writerTimeoutMs. */
  writerTotalMs?: number;
  /**
   * Остановка запуска: обрывает вызов писателя (Gemini думает минутами, и без
   * сигнала «Остановить» ждало бы его и заплатило), строка шаблона
   * освобождается как failed — «Переписать цепочку» не ждёт 15 минут.
   */
  signal?: AbortSignal;
}

interface TemplateRow {
  id: string;
  offer_key: string;
  status: string;
  letters: unknown;
  qa_flags: string[] | null;
  model: string | null;
  cost_usd: number | string | null;
  attempt: number | null;
  error: string | null;
  updated_at: string;
}

function log(level: 'info' | 'warn', msg: string): void {
  console[level](`[polza-outreach][templates][${level.toUpperCase()}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/* ─────────────────────────── Промпт писателя ─────────────────────────── */

interface OfferBrief {
  /** Как оффер назван в промпте (по-английски: промпт и письма английские). */
  title: string;
  essence: string;
  goals: [string, string, string, string];
}

const POLZA_WHAT =
  'Polza builds the account list, enriches the right contacts, writes and launches the outbound sequence on their behalf and tracks replies, handing interested ones to their team';
const LETTER3 =
  'proof: the "with case" variant opens with {{case}}, the "without case" variant with {{segments}} (the first segments we would test for them; it may follow {{case}} in the "with case" variant too); then offer a small free sample of 20–30 target accounts so they can judge the quality before any call; the one question: whether to send the sample';
const LETTER4 =
  'close the loop politely: the last email, no pressure; if new pipeline is relevant, the account sample for {{company}} is still on the table; if not, a short "not now" is enough and we will not follow up; the one question: should I close the loop';

/** Суть оффера и цель каждого письма — пересказ цепочки CEO (buildLetters) под тип повода. */
const OFFER_BRIEFS: Record<PolzaOfferKey, OfferBrief> = {
  hiring: {
    title: 'Hiring for sales/GTM',
    essence: `The company is hiring for a sales/GTM role (SDR, BDR, AE, Head of Sales). We do not write about the hire itself or about recruiting. ${POLZA_WHAT}, so new pipeline can start moving in parallel with the hire and a new rep does not spend the ramp-up on manual research.`,
    goals: [
      '{{trigger}} — the hiring signal; usually at this stage the hard part is not sending more emails but finding the right accounts and the right angle and getting first qualified replies fast; what Polza does in one line',
      "why it is slow: when a team is {{trigger_short}}, the bottleneck is usually not the email tool but which companies to target, which contacts to use, what angle to test first and how to avoid a generic cold email; Polza takes that off the new hire's plate",
      LETTER3,
      LETTER4,
    ],
  },
  yc: {
    title: 'Y Combinator startup',
    essence: `The company went through Y Combinator. At this stage the job is proving repeatable GTM fast: finding the first right-fit B2B accounts and getting qualified replies. ${POLZA_WHAT}, so the founders are not stuck doing manual prospecting.`,
    goals: [
      '{{trigger}} — the YC signal; at this stage the hard part is not sending more emails but finding the first right-fit accounts and a message that gets qualified replies; what Polza does in one line',
      'why it is slow: when a team is {{trigger_short}}, founders usually prospect by hand — list building, contacts, angles, follow-ups — and it eats the time the product needs; Polza runs that end-to-end',
      LETTER3,
      LETTER4,
    ],
  },
  launch: {
    title: 'Recent product launch',
    essence: `The company recently launched a product or a major feature. The next step is finding the first right B2B accounts for it and getting early qualified conversations while the launch is fresh. ${POLZA_WHAT}.`,
    goals: [
      '{{trigger}} — the launch signal; after a launch the hard part is finding the right first accounts for it, not sending more emails; what Polza does in one line',
      'why it is slow: when a team is {{trigger_short}}, inbound is small at the start and the list of right-fit accounts has to be built from scratch — which companies, which contacts, what angle; Polza runs that end-to-end',
      LETTER3,
      LETTER4,
    ],
  },
  tech_stack: {
    title: 'Already runs outbound/CRM tools',
    essence: `The company already uses outbound/CRM tools, so the bottleneck is probably not sending but account selection and the angle. ${POLZA_WHAT}: the right accounts, contacts and a tested angle go into the tools they already have.`,
    goals: [
      '{{trigger}} — they already run outbound tools; the bottleneck is usually account selection and the angle, not sending; what Polza does in one line',
      'why tools alone do not fix it: when a team is {{trigger_short}}, the slow part is which companies to target, which contacts to use, what angle to test first and how to avoid a generic cold email; Polza handles that end-to-end',
      LETTER3,
      LETTER4,
    ],
  },
  none: {
    title: 'No specific trigger',
    essence: `There is no specific signal: the company looks like a Polza client — it sells B2B to a clear audience. Offer outbound as a channel for new B2B pipeline: ${POLZA_WHAT}.`,
    goals: [
      'what Polza does and why outbound works for B2B teams, as a general observation (this offer has no {{trigger}})',
      'why outbound is slow to set up in-house: when a team is {{trigger_short}}, the slow part is which companies to target, which contacts to use, what angle to test first and how to avoid a generic cold email; Polza handles that end-to-end',
      LETTER3,
      LETTER4,
    ],
  },
};

const EXAMPLE_COMPANY = 'Acme';

/**
 * Как выглядит {{trigger}} у оффера — из того же triggerPhrase, что подставит
 * его компаниям. Должности примеров — нарочно приметные (не «head of sales»,
 * которую шаблон мог бы назвать и сам): проверка ищет их в шаблоне как
 * перенесённый пример.
 */
const EXAMPLE_TRIGGERS: Record<PolzaOfferKey, Trigger[]> = {
  hiring: [
    { type: 'hiring', title: 'Sales Development Representative', url: null, date: null, quote: null },
    { type: 'hiring', title: 'Founding Account Executive', url: null, date: null, quote: null },
  ],
  yc: [{ type: 'yc', title: 'W24', url: null, date: null, quote: null }],
  launch: [{ type: 'launch', title: 'Acme launched its self-serve workspace', url: null, date: null, quote: null }],
  tech_stack: [{ type: 'tech_stack', title: 'HubSpot, Apollo', url: null, date: null, quote: null }],
  none: [],
};

/**
 * Приметные куски примеров задания — в шаблоне их быть не должно: это чужая
 * компания и чужой повод в письме всем компаниям оффера (guardTemplate,
 * example_leak). Хвосты фраз-поводов тоже здесь: шаблон, повторивший
 * {{trigger}} своими словами, сказал бы о повторе дважды или приписал его
 * компании, у которой повод другой.
 */
const EXAMPLE_FRAGMENTS = [
  EXAMPLE_COMPANY,
  'Sales Development Representative',
  'Founding Account Executive',
  'W24',
  'HubSpot',
  'Apollo',
  'self-serve workspace',
  'is becoming a priority',
  'proving repeatable GTM fast',
  'was part of YC',
  'Saw the recent launch',
  'the right first B2B accounts',
  'already uses outbound/CRM tools',
  'not sending but account selection',
];

/** Примеры задания для проверки шаблона (guardTemplate): один список для ответа писателя и для образца. */
export function templateQaExamples(): readonly string[] {
  return EXAMPLE_FRAGMENTS;
}

// Образец собирается на фиктивной компании, затем повод, кейс, сегменты и
// подпись заменяются плейсхолдерами: так писатель видит, где что стоит.
const SAMPLE_CASE: EnCase = { caseId: 'sample', segment: 'B2B software', snippet: 'a sample client get their first replies', url: null, groups: [] };
const SAMPLE_SEGMENTS = ['sample segment one', 'sample segment two', 'sample segment three'];

/**
 * Образец — нынешняя цепочка CEO (buildLetters) для оффера, собранная на
 * плейсхолдерах, в виде шаблона. Письмо 1 у CEO одно на все ящики и
 * спрашивает, кто отвечает за outbound, — это вариант для общего ящика; он же
 * стоит и на месте прямого. Экспорт — чтобы проверка шаблона (guardTemplate)
 * сверялась с образцом: правило, которое бракует цепочку CEO, бракует и
 * писателя, который её повторил.
 */
export function sampleTemplateLetters(offer: PolzaOfferKey): PolzaChainTemplateLetters {
  const trigger = EXAMPLE_TRIGGERS[offer][0] ?? null;
  const withCase = buildLetters({ company: EXAMPLE_COMPANY, trigger, caseHit: SAMPLE_CASE, segments: SAMPLE_SEGMENTS });
  const noCase = buildLetters({ company: EXAMPLE_COMPANY, trigger, caseHit: null, segments: SAMPLE_SEGMENTS });
  // Сначала целые фразы (в них есть название компании), потом само название.
  const swaps: Array<[string | null, string]> = [
    [triggerPhrase(EXAMPLE_COMPANY, trigger), P.trigger],
    [caseSentence(SAMPLE_CASE), P.case],
    [segmentsBlock(EXAMPLE_COMPANY, SAMPLE_SEGMENTS), P.segments],
    [POLZA_OUTREACH_DEFAULT_SIGNATURE, P.signature],
    [triggerShort(trigger), P.triggerShort],
    [EXAMPLE_COMPANY, P.company],
  ];
  const text = (value: string) => swaps.reduce((out, [piece, placeholder]) => (piece ? out.split(piece).join(placeholder) : out), value);
  return {
    subject: text(withCase[0].subject),
    bodyDirect: text(withCase[0].body),
    bodyRouting: text(withCase[0].body),
    letter2: text(withCase[1].body),
    bodyWithCase: text(withCase[2].body),
    bodyWithoutCase: text(noCase[2].body),
    letter4: text(withCase[3].body),
  };
}

function sampleChain(offer: PolzaOfferKey): string {
  const t = sampleTemplateLetters(offer);
  return [
    `SUBJECT OF EMAIL 1: ${t.subject}`,
    '',
    'EMAIL 1 (today one version for every inbox; it asks who owns outbound, so it is the shared-inbox variant — write body_direct from the goals):',
    t.bodyRouting,
    '',
    'EMAIL 2:',
    t.letter2,
    '',
    'EMAIL 3 — WITH CASE (today the case and the segments go together):',
    t.bodyWithCase,
    '',
    'EMAIL 3 — WITHOUT CASE:',
    t.bodyWithoutCase,
    '',
    'EMAIL 4:',
    t.letter4,
  ].join('\n');
}

const WRITER_SYSTEM = [
  "You write cold emails for Polza Agency, a B2B outbound agency: we build the list of target accounts for a client, find and enrich the right contacts, write and launch the outbound sequence on the client's behalf and hand interested replies to the client's team.",
  'You write a TEMPLATE of a four-email sequence for one offer. One template serves every company of the offer: code replaces only the placeholders for each company, and everything else goes out exactly as you wrote it. So the text says nothing about a specific company beyond the placeholders.',
  '',
  'PLACEHOLDERS — spelled exactly like this, no other {{…}} exist:',
  '{{company}} — the recipient company name (e.g. "Acme"). Use it inside sentences.',
  '{{trigger}} — a ready sentence about the verified reason we are writing, ending with a period (e.g. "Saw that Acme is hiring for Founding Account Executive, looks like outbound/GTM is becoming a priority."). Put it in a paragraph of its own. It can be empty and then its paragraph is removed, so the email must read fine without it. Do not repeat its meaning in your own words.',
  '{{trigger_short}} — a short phrase for the same reason to use inside a sentence (e.g. "hiring for GTM roles": "when a team is {{trigger_short}}, …").',
  '{{case}} — one complete sentence about an approved Polza client case, inserted verbatim (e.g. "For a similar B2B software company, we helped … get … replies."). A paragraph of its own.',
  '{{segments}} — a short block with the first 2–3 segments we would test for the company, with its own lead-in line ("For Acme, I would probably start with:" and a numbered list). A paragraph of its own, no lead-in of yours before it. It can be empty and then its paragraph is removed.',
  '{{signature}} — the sender signature block (several lines).',
  '',
  'RULES:',
  '1. Every email starts with the line "Hi there," and ends with a blank line followed by {{signature}} as the very last line. No "Best,"/"Thanks," line — the signature block closes the email.',
  '2. Separate paragraphs with a blank line.',
  '3. Exactly one question mark in every email — one call to action.',
  '4. Email 1 has a subject line: short, lowercase, no "!", may contain {{company}}, no other placeholder. Emails 2–4 are replies in the same thread and have no subject.',
  '5. The only number allowed is "20–30", and only in the phrase about the free sample of 20–30 accounts; the numbers of a case come only inside {{case}}. Never invent results or promises: no percentages; no multipliers or amounts, in digits or in words ("twice", "double", "2x", "tenfold", "in half", "dozens", "hundreds", "thousands", "three meetings", "ten leads"); no time-frame promises ("in two weeks", "within a month", "in the next few weeks", "by next quarter"). Proposing a call "next week" or "this week" is fine.',
  '6. Nothing about the recipient beyond the placeholders: do not guess their market, customers, plans or problems. The pain is a general observation about outbound, not a diagnosis of the recipient.',
  '7. We have never talked to the recipient: no "as we discussed", "following up on our call", "we spoke". Emails 2–4 follow up on my own previous email.',
  '8. Never: urgency or scarcity pressure, guarantees, hype words ("leading", "world-class", "revolutionary", "best-in-class", "full-service"), exclamation marks, emoji, markdown (**bold**, # headings), internal words (score, scoring, ICP, LLM, JSON, null, evidence, validation). Plain dash lists like in the sample are fine.',
  '9. Tone — like the sample: short, plain, peer-to-peer, first person of the sender, natural American business English, no filler and no corporate jargon. Keep every email under about 90 words; email 4 is the shortest.',
  '10. {{trigger}}, {{case}} and {{segments}} are paragraphs of their own: a blank line before and after, no other text, and no lead-in line ending with ":" right before them — when a value is empty, its paragraph is removed and nothing must dangle.',
  `11. The examples in this task (the company "${EXAMPLE_COMPANY}", its job titles and trigger phrases) only show what the code will insert — never copy them or their wording into the template.`,
  '',
  'Answer with a strict JSON object in the format from the message, with no markdown and no comments.',
].join('\n');

const CONTRACT = [
  '{"letters":[',
  '  {"n":1,"subject":"…","body_direct":"…","body_routing":"…"},',
  '  {"n":2,"body":"…"},',
  '  {"n":3,"body_with_case":"…","body_without_case":"…"},',
  '  {"n":4,"body":"…"}]}',
].join('\n');

interface RetryNote {
  flags: string[];
  previous: unknown;
}

function writerUserPrompt(offer: PolzaOfferKey, retry: RetryNote | null): string {
  const brief = OFFER_BRIEFS[offer];
  const hasTrigger = offer !== 'none';
  const places = [
    ...(hasTrigger ? [`${P.trigger} — in email 1, both variants`] : []),
    `${P.case} — only in email 3 "with case"`,
    `${P.segments} — in email 3 "without case" (it may also follow ${P.case} in "with case")`,
    `${P.signature} — the last line of every email`,
  ];
  const examples = EXAMPLE_TRIGGERS[offer].map((t) => triggerPhrase(EXAMPLE_COMPANY, t)).filter((s): s is string => Boolean(s));
  const lines = [
    `OFFER: ${brief.title}`,
    `ESSENCE: ${brief.essence}`,
    'EMAIL GOALS:',
    ...brief.goals.map((goal, i) => `${i + 1} — ${goal}`),
    'body_direct — email 1 for a sales or personal inbox: the reader may be the right person, so the one question is about their interest (whether new pipeline is a priority, whether it is worth a look), or a soft fork: relevant for you, or who owns this on your team.',
    'body_routing — email 1 for a shared inbox (info@, hello@, contact@): the reader is not the decision-maker. Ask who is the right person to talk to about new B2B pipeline and outbound, or ask them to forward this email to that person; explain in one line what we do.',
    '',
    `PLACEHOLDERS OF THIS OFFER: ${polzaTemplatePlaceholdersFor(offer).join(', ')}.`,
    ...(hasTrigger ? [] : [`This offer has no ${P.trigger}: do not use it.`]),
    `REQUIRED: ${places.join('; ')}.`,
    ...(examples.length
      ? [
          `${P.trigger} for this offer looks like this (example for "${EXAMPLE_COMPANY}" — code inserts it, never copy it into the template):`,
          ...examples.map((example) => `— ${example}`),
        ]
      : []),
    `${P.triggerShort} for this offer: "${triggerShort(EXAMPLE_TRIGGERS[offer][0] ?? null)}".`,
    '',
    'SAMPLE — the current sequence approved by the CEO. Keep its meaning, order and tone; you may improve the wording:',
    sampleChain(offer),
    '',
    'ANSWER FORMAT — JSON:',
    CONTRACT,
    'Inside JSON strings separate paragraphs with \\n\\n and lines inside one paragraph (lists) with \\n.',
  ];
  if (retry) {
    lines.push(
      '',
      'THE PREVIOUS VERSION FAILED THE CHECK. Fix every remark and return the whole sequence again:',
      ...retry.flags.map((flag) => `— ${describeTemplateFlag(flag)}`),
      'Previous version:',
      JSON.stringify(retry.previous),
    );
  }
  return lines.join('\n');
}

/* ─────────────────────────── Разбор ответа ─────────────────────────── */

// Строка-прощание перед подписью: у цепочки CEO его нет — подпись сама
// закрывает письмо, а «Best,» над ней выглядел бы оборванным.
const SIGN_OFF_LINE =
  /^(?:best|best regards|best wishes|kind regards|warm regards|warmest regards|warmly|regards|thanks|thank you|thanks again|thanks in advance|many thanks|cheers|all the best|talk soon|speak soon|looking forward|sincerely|yours(?: truly| sincerely)?)[,.!]?$/i;

/** Тело письма: переводы строк, хвостовые пробелы и концовка с подписью — в одном виде. */
function normalizeBody(value: unknown): string {
  if (typeof value !== 'string') return '';
  let text = value.replace(/\r\n?/g, '\n');
  // Модель иногда экранирует перевод строки дважды — в тексте остаётся «\n».
  if (!text.includes('\n') && text.includes('\\n')) text = text.replace(/\\n/g, '\n');
  // «20-30», «20 to 30» → «20–30»: проверка шаблона и гард писем видят одну запись.
  text = normalizeSampleRange(text.replace(/[ \t]+\n/g, '\n').trim());
  const end = /\n\s*\{\{signature\}\}$/.exec(text);
  if (!end) return text;
  // Подпись — последним абзацем: одна пустая строка перед ней, без «Best,».
  const lines = text.slice(0, end.index).trimEnd().split('\n');
  if (lines.length > 1 && SIGN_OFF_LINE.test(lines[lines.length - 1].trim())) lines.pop();
  return `${lines.join('\n').trimEnd()}\n\n${P.signature}`;
}

/**
 * Письма шаблона из ответа писателя или из строки базы (тот же контракт).
 * Нет массива letters — null; недостающее поле — пустая строка, её поймает
 * guardTemplate («текст пустой»).
 */
export function parseTemplateLetters(raw: unknown): PolzaChainTemplateLetters | null {
  const list = raw && typeof raw === 'object' ? (raw as { letters?: unknown }).letters : undefined;
  const items: unknown[] | null = Array.isArray(list) ? list : list && typeof list === 'object' ? Object.values(list) : null;
  if (!items) return null;
  const byN = new Map<number, Record<string, unknown>>();
  items.forEach((item, i) => {
    if (!item || typeof item !== 'object') return;
    const n = Number((item as { n?: unknown }).n ?? i + 1);
    if (!byN.has(n)) byN.set(n, item as Record<string, unknown>);
  });
  const field = (n: number, key: string) => normalizeBody(byN.get(n)?.[key]);
  return {
    subject: field(1, 'subject').replace(/\s+/g, ' '),
    bodyDirect: field(1, 'body_direct'),
    bodyRouting: field(1, 'body_routing'),
    letter2: field(2, 'body'),
    bodyWithCase: field(3, 'body_with_case'),
    bodyWithoutCase: field(3, 'body_without_case'),
    letter4: field(4, 'body'),
  };
}

/** Письма шаблона в контракт писателя — так они лежат в polza_chain_templates.letters. */
export function templateLettersToJson(t: PolzaChainTemplateLetters): Array<Record<string, unknown>> {
  return [
    { n: 1, subject: t.subject, body_direct: t.bodyDirect, body_routing: t.bodyRouting },
    { n: 2, body: t.letter2 },
    { n: 3, body_with_case: t.bodyWithCase, body_without_case: t.bodyWithoutCase },
    { n: 4, body: t.letter4 },
  ];
}

/* ─────────────────────────── Строка в базе ─────────────────────────── */

function isStale(row: Pick<TemplateRow, 'updated_at'>, staleMs = PENDING_STALE_MS): boolean {
  const t = Date.parse(row.updated_at);
  return !Number.isFinite(t) || Date.now() - t > staleMs;
}

/** Строка failed, потому что модель не ответила (а не проверка, лимит, ключ или остановка). */
function aiFailedRow(row: TemplateRow): boolean {
  return row.status === 'failed' && (row.error ?? '').startsWith(AI_FAILED_PREFIX);
}

function templateFromRow(row: TemplateRow, offer: PolzaOfferKey): ChainTemplate {
  const letters = row.letters ? parseTemplateLetters({ letters: row.letters }) : null;
  const ok = row.status === 'ok' && letters !== null;
  return {
    id: row.id,
    offer,
    status: ok ? 'ok' : 'failed',
    letters,
    qaFlags: row.qa_flags ?? [],
    error: row.error ?? (row.status === 'ok' && !letters ? 'письма шаблона в базе не разбираются' : null),
    aiFailed: aiFailedRow(row),
    model: row.model,
    costUsd: Number(row.cost_usd ?? 0) || 0,
    attempt: Number(row.attempt ?? 0) || 0,
  };
}

/** key — оффер или ключ маркера пересборки (REBUILD_LEASE_KEY). */
async function readRow(db: SupabaseClient, jobId: string, key: string): Promise<TemplateRow | null> {
  const { data, error } = await db.from(TABLE).select(ROW_COLUMNS).eq('job_id', jobId).eq('lang', LANG).eq('offer_key', key).maybeSingle();
  if (error) throw new Error(`Не удалось прочитать цепочку оффера «${key}»: ${error.message}`);
  return (data as TemplateRow | null) ?? null;
}

/**
 * Первая генерация оффера в запуске: строка сразу вставляется pending — она
 * наша. Уже есть (её занял другой процесс) — null: insert … on conflict do
 * nothing возвращает только вставленное.
 */
async function claimNew(db: SupabaseClient, jobId: string, key: string): Promise<TemplateRow | null> {
  const { data, error } = await db
    .from(TABLE)
    .upsert(
      {
        job_id: jobId, lang: LANG, offer_key: key, status: 'pending', letters: null, qa_flags: [],
        cost_usd: 0, attempt: 1, error: null, updated_at: new Date().toISOString(),
      },
      { onConflict: 'job_id,lang,offer_key', ignoreDuplicates: true },
    )
    .select(ROW_COLUMNS);
  if (error) throw new Error(`Не удалось занять цепочку оффера «${key}»: ${error.message}`);
  return ((data ?? []) as TemplateRow[])[0] ?? null;
}

/**
 * Новая попытка на готовой строке: failed, ok (перечитать не удалось) или
 * pending, чей процесс умер. Условие по attempt и статусу — сравнение с
 * обменом: из двух одновременных попыток строку займёт одна, вторая получит
 * null и платить не будет.
 */
async function claimExisting(db: SupabaseClient, row: TemplateRow, staleMs = PENDING_STALE_MS): Promise<TemplateRow | null> {
  const attempt = Number(row.attempt ?? 0) || 0;
  const base = db
    .from(TABLE)
    .update({ status: 'pending', attempt: attempt + 1, error: null, updated_at: new Date().toISOString() })
    .eq('id', row.id)
    .eq('attempt', attempt);
  const query = row.status === 'pending'
    ? base.eq('status', 'pending').lt('updated_at', new Date(Date.now() - staleMs).toISOString())
    : base.neq('status', 'pending');
  const { data, error } = await query.select(ROW_COLUMNS);
  if (error) throw new Error(`Не удалось занять цепочку оффера «${row.offer_key}»: ${error.message}`);
  return ((data ?? []) as TemplateRow[])[0] ?? null;
}

/**
 * Итог в строку — только пока она наша (pending с нашей попыткой): если её
 * заняли заново как зависшую, чужой результат не перетираем. Сбой записи —
 * ещё раз; не вышло — шаблон всё равно отдаём запуску: он оплачен.
 */
async function finishRow(db: SupabaseClient, claimed: TemplateRow, patch: Record<string, unknown>): Promise<boolean> {
  for (let i = 0; i < 2; i += 1) {
    const { data, error } = await db
      .from(TABLE)
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', claimed.id)
      .eq('status', 'pending')
      .eq('attempt', Number(claimed.attempt ?? 0) || 0)
      .select('id');
    if (!error) return Boolean(data?.length);
    log('warn', `template ${claimed.id} save failed: ${error.message}`);
  }
  return false;
}

/* ─────────────────────────── Генерация ─────────────────────────── */

/**
 * Писатель пишет шаблон в занятую строку: попытка, проверка, при провале —
 * повтор с замечаниями. Итог — в строку. Лимит на ИИ, ключ, остановка запуска
 * и прочие непредвиденные ошибки освобождают строку (failed с текстом) и летят
 * дальше: они про весь запуск, а не про оффер.
 */
async function writeTemplate(deps: TemplateWriterDeps, offer: PolzaOfferKey, claimed: TemplateRow): Promise<ChainTemplate> {
  const firstAttempt = Number(claimed.attempt ?? 1) || 1;
  const deadline = deps.writerTotalMs ? Date.now() + deps.writerTotalMs : null;
  let cost = 0;
  let model = claimed.model;
  let calls = 0;
  let letters: PolzaChainTemplateLetters | null = null;
  let flags: string[] = [];
  let error: string | null = null;
  let fatal: unknown = null;
  let retry: RetryNote | null = null;
  const onUsage = (usage: OutreachLlmUsage) => {
    cost += usage.costUsd;
    model = usage.model;
  };
  try {
    for (let attempt = 1; attempt <= MAX_WRITER_ATTEMPTS; attempt += 1) {
      const left = deadline === null ? Infinity : deadline - Date.now();
      if (attempt > 1 && left < MIN_RETRY_MS) {
        // В роуте повтор не успел бы до ответа пользователю: шаблон failed с
        // замечаниями первой попытки, «Переписать цепочку» можно нажать ещё раз.
        log('warn', `job ${deps.jobId}: offer ${offer} — no time left for the retry with remarks (${Math.round(left / 1000)} s)`);
        break;
      }
      calls += 1;
      const raw = await callOutreachJson({
        role: 'writer',
        system: WRITER_SYSTEM,
        user: writerUserPrompt(offer, retry),
        title: `chain-${offer}`,
        maxTokens: WRITER_MAX_TOKENS,
        lang: LANG,
        onUsage,
        timeoutMs: Math.min(deps.writerTimeoutMs, left),
        signal: deps.signal,
      });
      letters = parseTemplateLetters(raw);
      flags = letters ? guardTemplate(letters, offer, EXAMPLE_FRAGMENTS).flags : ['letters_missing'];
      if (!flags.length) break;
      log('warn', `job ${deps.jobId}: offer ${offer} attempt ${attempt} failed QA: ${flags.join(', ')}`);
      retry = { flags, previous: raw };
    }
  } catch (err) {
    if (deps.signal?.aborted) {
      // Запуск остановили посреди записи: строку освобождаем как failed — не
      // pending, иначе «Переписать цепочку» ждала бы её 15 минут, — а
      // остановку отдаём дальше. Оборванный запрос клиент уже списал с лимита.
      fatal = err;
      error = 'запуск остановлен, цепочка не дописана';
    } else if (err instanceof LlmCallError) {
      // Клиент уже повторил сеть, 5xx и битый JSON — третий раз писать не просим.
      error = `${AI_FAILED_PREFIX}${err.message}`;
    } else {
      fatal = err;
      error = err instanceof BudgetExceededError
        ? 'лимит на ИИ исчерпан раньше, чем цепочка была написана'
        : err instanceof Error ? err.message : String(err);
    }
  }
  const ok = !error && letters !== null && flags.length === 0;
  const template: ChainTemplate = {
    id: claimed.id,
    offer,
    status: ok ? 'ok' : 'failed',
    letters,
    qaFlags: flags,
    error,
    aiFailed: !fatal && Boolean(error?.startsWith(AI_FAILED_PREFIX)),
    model,
    costUsd: roundUsd((Number(claimed.cost_usd ?? 0) || 0) + cost),
    attempt: firstAttempt + Math.max(0, calls - 1),
  };
  const saved = await finishRow(deps.db, claimed, {
    status: template.status,
    letters: letters ? templateLettersToJson(letters) : null,
    qa_flags: flags,
    model,
    cost_usd: template.costUsd,
    attempt: template.attempt,
    error: error ? error.slice(0, 1000) : null,
  });
  if (!saved) log('warn', `job ${deps.jobId}: offer ${offer} result not saved (row ${claimed.id} was taken over or the DB failed)`);
  log('info', `job ${deps.jobId}: offer ${offer} ${template.status} after ${calls} writer call(s), $${cost.toFixed(4)}${error ? ` — ${error}` : ''}`);
  if (fatal) throw fatal;
  return template;
}

/**
 * Шаблон оффера для воркера: своя строка или готовая чужая. Чужую pending
 * (её пишет другой процесс) ждём, пока допишет; умер — занимаем заново.
 * reclaimAiFailed — шаблон, не написанный из-за молчания модели, занять и
 * написать ещё раз (раннер просит об этом один раз на оффер, в следующей волне).
 */
async function obtainTemplate(deps: TemplateWriterDeps, offer: PolzaOfferKey, reclaimAiFailed = false): Promise<ChainTemplate> {
  const deadline = Date.now() + PENDING_STALE_MS + 2 * POLL_MS;
  let reclaim = reclaimAiFailed;
  for (;;) {
    // Запуск остановили, пока ждали чужую запись, — не ждём дальше.
    deps.signal?.throwIfAborted();
    const claimed = await claimNew(deps.db, deps.jobId, offer);
    if (claimed) return writeTemplate(deps, offer, claimed);
    const row = await readRow(deps.db, deps.jobId, offer);
    if (row && row.status !== 'pending') {
      if (reclaim && aiFailedRow(row)) {
        // Одна попытка занять: не вышло — строку уже пишет кто-то другой,
        // ждём его результата, как у любой чужой pending.
        reclaim = false;
        const taken = await claimExisting(deps.db, row);
        if (taken) return writeTemplate(deps, offer, taken);
        continue;
      }
      return templateFromRow(row, offer);
    }
    if (row && isStale(row)) {
      const taken = await claimExisting(deps.db, row);
      if (taken) return writeTemplate(deps, offer, taken);
    }
    if (Date.now() > deadline) {
      throw new Error(`Цепочка оффера «${offer}» не дописана другим процессом за ${Math.round(PENDING_STALE_MS / 60_000)} мин`);
    }
    await sleep(POLL_MS);
  }
}

export interface ChainTemplates {
  get(offer: PolzaOfferKey): Promise<ChainTemplate>;
  /**
   * Шаблоны, не написанные из-за молчания модели (сеть, 5xx, битый ответ), —
   * забыть, чтобы следующая компания оффера один раз попробовала заново:
   * сбой Requesty на минуту не должен оставить оффер без писем до конца
   * запуска. Раннер зовёт это между волнами; провал проверки не забываем —
   * писатель ответил, и тот же запрос дал бы то же. Каждый оффер — не больше
   * одного такого повтора за запуск. Возвращает офферы, которые попробуют снова.
   */
  retryAiFailures(): PolzaOfferKey[];
}

/**
 * Шаблоны запуска в воркере: один промис на оффер — компании оффера, дошедшие
 * до писем одновременно, ждут одного писателя.
 */
export function createChainTemplates(deps: TemplateWriterDeps): ChainTemplates {
  const byOffer = new Map<PolzaOfferKey, Promise<ChainTemplate>>();
  const settled = new Map<PolzaOfferKey, ChainTemplate>();
  const retried = new Set<PolzaOfferKey>();
  const reclaim = new Set<PolzaOfferKey>();
  return {
    get(offer) {
      const known = byOffer.get(offer);
      if (known) return known;
      const promise = obtainTemplate(deps, offer, reclaim.delete(offer));
      byOffer.set(offer, promise);
      promise.then(
        (template) => {
          settled.set(offer, template);
        },
        // Сбой базы или остановка — не ответ писателя: следующая компания
        // оффера попробует снова. Лимит на ИИ и ключ — про весь запуск, их
        // запоминаем.
        (err: unknown) => {
          if (!(err instanceof BudgetExceededError) && !(err instanceof LlmAuthError)) byOffer.delete(offer);
        },
      );
      return promise;
    },
    retryAiFailures() {
      const offers: PolzaOfferKey[] = [];
      for (const [offer, template] of settled) {
        if (template.status !== 'failed' || !template.aiFailed || retried.has(offer)) continue;
        retried.add(offer);
        reclaim.add(offer);
        byOffer.delete(offer);
        settled.delete(offer);
        offers.push(offer);
      }
      return offers;
    },
  };
}

export type RegenerateTemplateResult =
  | { kind: 'missing' }
  | { kind: 'busy' }
  | { kind: 'done'; template: ChainTemplate; wrote: boolean };

/**
 * «Переписать цепочку»: новая попытка писателя для failed или зависшей
 * pending строки. Шаблон уже прошёл проверку — писатель не нужен, возвращаем
 * его (роут пересоберёт письма застрявших строк). Строку пишет кто-то ещё —
 * busy.
 */
export async function regenerateChainTemplate(deps: TemplateWriterDeps, offer: PolzaOfferKey): Promise<RegenerateTemplateResult> {
  const row = await readRow(deps.db, deps.jobId, offer);
  if (!row) return { kind: 'missing' };
  if (row.status === 'ok') {
    const current = templateFromRow(row, offer);
    if (current.status === 'ok') return { kind: 'done', template: current, wrote: false };
  }
  if (row.status === 'pending' && !isStale(row)) return { kind: 'busy' };
  const claimed = await claimExisting(deps.db, row);
  if (!claimed) return { kind: 'busy' };
  return { kind: 'done', template: await writeTemplate(deps, offer, claimed), wrote: true };
}

/**
 * Почему шаблон оффера не готов — подробность причины строки
 * (template_failed: …), по-русски и коротко: оператор читает её в таблице.
 */
export function templateFailureDetail(t: { qaFlags: readonly string[]; error: string | null }): string {
  if (t.error) return `не написана: ${t.error}`;
  const shown = t.qaFlags.slice(0, 3).map((flag) => describeTemplateFlag(flag, 'ru'));
  const more = t.qaFlags.length > 3 ? ` и ещё ${t.qaFlags.length - 3}` : '';
  return `не прошла проверку: ${shown.join('; ')}${more}`;
}

/** Шаблон оффера запуска как он есть в базе: id и статус; нет строки — null. */
export async function findChainTemplate(db: SupabaseClient, jobId: string, offer: PolzaOfferKey): Promise<{ id: string; status: string } | null> {
  const row = await readRow(db, jobId, offer);
  return row ? { id: row.id, status: row.status } : null;
}

/* ─────────────────────── Пересборка писем: один роут на запуск ─────────────────────── */

/**
 * Маркер «письма запуска сейчас пересобираются» — строка этой же таблицы с
 * особым ключом вместо оффера. Две пересборки разных офферов одного запуска
 * параллельно считали бы свободные места в лимите готовых каждая по себе и
 * вместе набрали бы готовых больше заказанного, а расход дописывали бы в
 * progress_detail наперегонки. Отдельной таблицы под замок нет, а здесь уже
 * есть атомарное занятие строки (insert … on conflict do nothing и сравнение
 * attempt), доступ пользователя к строкам своего запуска и уборка вместе с
 * шаблонами при новом прогоне. Экран и список шаблонов этот ключ пропускают.
 */
export const REBUILD_LEASE_KEY = '_rebuild';
/**
 * Маркер старше этого — роут, который его занял, умер (перезапуск Next): его
 * можно занять заново. Дольше maxDuration роута (280 с) с запасом.
 */
const REBUILD_LEASE_STALE_MS = 6 * 60_000;

export interface RebuildLease {
  id: string;
  attempt: number;
}

/** Занять пересборку запуска; занята другим роутом — null. */
export async function claimRebuildLease(db: SupabaseClient, jobId: string): Promise<RebuildLease | null> {
  const fresh = await claimNew(db, jobId, REBUILD_LEASE_KEY);
  const row = fresh ?? (await readRow(db, jobId, REBUILD_LEASE_KEY));
  if (!row) return null;
  const claimed = fresh ?? (row.status === 'pending' && !isStale(row, REBUILD_LEASE_STALE_MS) ? null : await claimExisting(db, row, REBUILD_LEASE_STALE_MS));
  return claimed ? { id: claimed.id, attempt: Number(claimed.attempt ?? 0) || 0 } : null;
}

/** Освободить пересборку — только свою (та же попытка): чужую, занятую после нашей смерти, не трогаем. */
export async function releaseRebuildLease(db: SupabaseClient, lease: RebuildLease): Promise<void> {
  const { error } = await db
    .from(TABLE)
    .update({ status: 'ok', updated_at: new Date().toISOString() })
    .eq('id', lease.id)
    .eq('status', 'pending')
    .eq('attempt', lease.attempt);
  if (error) log('warn', `rebuild lease ${lease.id} release failed: ${error.message} — it expires in ${REBUILD_LEASE_STALE_MS / 60_000} min`);
}

/**
 * Какой-то шаблон запуска сейчас пишется (pending и не завис) — писатель уже
 * работает в другом процессе, и пересборка сбоку разошлась бы с ним.
 */
export async function hasPendingTemplate(db: SupabaseClient, jobId: string): Promise<boolean> {
  const { data, error } = await db
    .from(TABLE)
    .select('id,updated_at')
    .eq('job_id', jobId)
    .eq('lang', LANG)
    .eq('status', 'pending')
    .neq('offer_key', REBUILD_LEASE_KEY);
  if (error) throw new Error(`Не удалось прочитать цепочки запуска: ${error.message}`);
  return ((data ?? []) as Array<Pick<TemplateRow, 'updated_at'>>).some((row) => !isStale(row));
}

/**
 * Письма компании из шаблона цепочки оффера (спека
 * 2026-09-26-outreach-to-sender-design.md §4).
 *
 * Шаблон пишет писатель один раз на оффер (templateWriter.ts); здесь под
 * компанию подставляются только проверенные факты: бренд, фраза-повод
 * (openingSentence — детерминированная, из подтверждённого сигнала), связка
 * повода с предложением (bridge.ts — дешёвая модель или запасная фраза), текст
 * утверждённого кейса, гипотеза сегментов и подпись. Выбор вариантов: письмо 1
 * лично ЛПР или «перешлите ответственному» (общая почта), письмо 3 с кейсом
 * или без. Строка с пустым значением удаляется целиком, как пустой абзац у
 * прежних цепочек (paragraphs()).
 *
 * Готовые письма проверяет тот же runQa, что и раньше: шаблон проверен до
 * подстановки (runTemplateQa), но подставленные факты — нет.
 */

import { claimsForChain, formatSignature, type CaseRecord, type OfferClaim, type SenderProfile } from '../libraries';
import { runQa } from '../qa';
import {
  LEGACY_ABOUT_PLACEHOLDER,
  TEMPLATE_PLACEHOLDERS,
  TEMPLATE_SIGN_OFF,
  letterCountFor,
  type ChainTemplateLetters,
  type ChainType,
  type Letter,
  type QaResult,
  type Signal,
} from '../types';
import { fallbackBridge, type BridgeRequest } from './bridge';
import { hypothesisText, openingSentence, siteObservationText, type ChainInput, type SegmentsHypothesis } from './chains';
import { FALLBACK_TOPIC } from './topic';

const P = TEMPLATE_PLACEHOLDERS;
const ANY_PLACEHOLDER = /\{\{[^{}]*\}\}/g;

export interface TemplateValues {
  brand: string;
  /** Фраза-повод (openingSentence); нет — строка с {{повод}} удаляется. */
  opening: string | null;
  /** Связка повода с предложением; нет — строка с {{связка}} удаляется. */
  bridge: string | null;
  /** Текст утверждённого кейса; есть и шаблон с кейсом — письмо 3 с кейсом. */
  caseText: string | null;
  /** Гипотеза сегментов текстом (hypothesisText); нет — строка удаляется. */
  hypothesis: string | null;
  /** Подпись отправителя целиком (formatSignature). */
  signature: string;
  /** Общая почта: письмо 1 — «перешлите ответственному». */
  isRouting: boolean;
  /** Предмет обсуждения ({{предмет}}); стоит внутри предложения — пустым не бывает. */
  topic?: string;
  /** Должность из вакансии в «ёлочках» ({{должность}}) — у цепочки «найм». */
  position?: string | null;
}

/** Должность, если у вакансии нет названия: стоит внутри предложения. */
const FALLBACK_POSITION = 'сотрудника в отдел продаж';

/** Одна из тем по компании — стабильно: у пересборки писем та же тема. */
function pickByBrand(options: string[], brand: string): string {
  let hash = 0;
  for (const ch of brand) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return options[hash % options.length];
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fill(text: string, values: Record<string, string | null>): string {
  let out = text;
  // Пустое значение убирает свою строку целиком: необязательный плейсхолдер
  // стоит отдельной строкой (это проверяет runTemplateQa).
  for (const [placeholder, value] of Object.entries(values)) {
    if (!value) out = out.replace(new RegExp(`^[ \\t]*${escapeRe(placeholder)}[ \\t]*(?:\\n|$)`, 'gm'), '');
  }
  // Один проход: подставленный текст (кейс, гипотеза) заново не разбирается.
  // Незнакомый плейсхолдер остаётся как есть — его поймает runQa (placeholder_left).
  out = out.replace(ANY_PLACEHOLDER, (found) => (found in values ? values[found] ?? '' : found));
  // Абзацы без пустых, как у прежних цепочек.
  return out
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .join('\n\n');
}

function renderBody(body: string, values: Record<string, string | null>): string {
  const text = body.replace(/\r\n?/g, '\n').trimEnd();
  if (!text.endsWith(TEMPLATE_SIGN_OFF)) return fill(text, values);
  // Подпись — ровно как signed() у прежних цепочек: runQa сверяет конец
  // письма с «С уважением,» и подписью посимвольно.
  return `${fill(text.slice(0, -TEMPLATE_SIGN_OFF.length), values)}\n\nС уважением,\n${values[P.signature] ?? ''}`;
}

/** Шаблон → четыре письма компании. Тема — только у письма 1: письма 2–4 идут ответом в той же ветке. */
export function renderTemplate(template: ChainTemplateLetters, v: TemplateValues): Letter[] {
  const values: Record<string, string | null> = {
    [P.brand]: v.brand,
    [P.opening]: v.opening,
    [P.bridge]: v.bridge,
    // Старые шаблоны: строки о компании в письмах больше нет — абзац удаляется.
    [LEGACY_ABOUT_PLACEHOLDER]: null,
    [P.case]: v.caseText,
    [P.hypothesis]: v.hypothesis,
    [P.signature]: v.signature,
    [P.topic]: v.topic ?? FALLBACK_TOPIC,
    [P.position]: v.position ?? FALLBACK_POSITION,
  };
  const withCase = Boolean(v.caseText) && template.bodyWithCase !== null;
  const routingSubjects = template.subjectsRouting?.filter((s) => s.trim()) ?? [];
  const subjectTemplate = v.isRouting && routingSubjects.length ? pickByBrand(routingSubjects, v.brand) : template.subject;
  const subject = subjectTemplate
    .replace(ANY_PLACEHOLDER, (found) => (found === P.brand ? v.brand : found))
    .replace(/\s+/g, ' ')
    .trim();
  return [
    { n: 1, subject, body: renderBody(v.isRouting ? template.bodyRouting : template.bodyDirect, values) },
    { n: 2, subject: '', body: renderBody(template.letter2, values) },
    { n: 3, subject: '', body: renderBody(withCase && template.bodyWithCase !== null ? template.bodyWithCase : template.bodyWithoutCase, values) },
    { n: 4, subject: '', body: renderBody(template.letter4, values) },
  ];
}

/** Всё о компании, что нужно письмам: из разбора в раннере или из строки журнала («Переписать цепочку»). */
export interface CompanyLettersInput {
  chain: ChainType;
  brand: string;
  isRouting: boolean;
  /** Главный повод цепочки (route.primary). */
  primary: Signal | null;
  /** Все поводы строки — их заголовки и цитаты письмо может повторять. */
  signals: Signal[];
  /** Был записанный разговор в AMO (исходная цепочка — «Возврат»). */
  priorContact: boolean;
  /** У «Автоматизации» — исходная цепочка: её повод идёт в {{повод}}. */
  baseChain?: ChainType;
  marketQuote: string | null;
  productSummary: string | null;
  targetMarket: string | null;
  caseRecord: CaseRecord | null;
  recipientEmail: string;
  amoStatus: string | null;
  /**
   * Второй вариант письма 1 для остальных адресов компании: вид, которого нет
   * у главного адреса (altRoutingFor), и адрес этого вида — для проверки.
   * null — все адреса одного вида, второй вариант не нужен.
   */
  alt?: { isRouting: boolean; recipientEmail: string } | null;
}

export interface CompanyLetters {
  letters: Letter[];
  qa: QaResult;
  /** Кейс, который стоит в письме 3; null — вариант без кейса. */
  caseId: string | null;
  /** Гипотеза сегментов в письме 3 — в строку как campaign_hypothesis. */
  hypothesisText: string | null;
  /** Утверждённые формулировки, дословно стоящие в письмах (offer_claim_ids). */
  claimIds: string[];
}

export interface CompanyLettersDeps {
  sender: SenderProfile;
  claims: OfferClaim[];
  /**
   * Гипотеза сегментов дешёвой моделью. null — письмо 3 без неё: гипотеза
   * необязательна, и лимит на ИИ или сбой модели строку не останавливают.
   */
  hypothesis: (req: { brand: string; productSummary: string | null; marketQuote: string }) => Promise<SegmentsHypothesis | null>;
  /**
   * Связка повода с предложением дешёвой моделью. null — запасная фраза по
   * офферу (fallbackBridge): лимит на ИИ или сбой модели строку не
   * останавливают.
   */
  bridge: (req: BridgeRequest) => Promise<string | null>;
  /**
   * Предмет обсуждения дешёвой моделью (letters/topic.ts). null — запасная
   * фраза FALLBACK_TOPIC: лимит на ИИ или сбой модели строку не останавливают.
   */
  topic: (productSummary: string | null) => Promise<string | null>;
}

/**
 * Письма компании: повод, кейс или гипотеза, подстановка в шаблон и
 * автопроверка готовых писем. Одно правило для раннера и для «Переписать
 * цепочку» — иначе пересобранные письма проверялись бы не так, как обычные.
 */
export async function composeCompanyLetters(
  template: ChainTemplateLetters,
  input: CompanyLettersInput,
  deps: CompanyLettersDeps,
): Promise<CompanyLetters> {
  const chainInput: ChainInput = {
    chain: input.chain,
    signal: input.primary,
    priorContact: input.priorContact,
    marketQuote: input.marketQuote,
    productSummary: input.productSummary,
    baseChain: input.baseChain,
  };
  const opening = openingSentence(chainInput, input.brand);
  // Связка нужна, только если есть повод и шаблон её ставит (старые шаблоны —
  // нет). У возврата повод — прошлый разговор, связывать нечего: модель не зовём.
  const firstBodies = [template.bodyDirect, template.bodyRouting].join('\n');
  const fallback = fallbackBridge(input.chain, input.baseChain);
  const bridge = opening && fallback && firstBodies.includes(P.bridge)
    ? (await deps.bridge({ chain: input.chain, baseChain: input.baseChain, brand: input.brand, opening, productSummary: input.productSummary })) ?? fallback
    : null;
  const caseText = input.caseRecord?.case_text_short.trim() || null;
  const withCase = Boolean(caseText) && template.bodyWithCase !== null;
  // Гипотезу считаем, только когда она попадёт в письмо и рынок подтверждён:
  // в утверждённых текстах (09.10.2026) — наблюдение по сайту в письме 2
  // всегда, в прежних шаблонах — абзац письма 3 без кейса. Иначе платили бы
  // за текст, которого никто не увидит.
  const marketQuote = input.marketQuote;
  const inLetter2 = template.letter2.includes(P.hypothesis);
  const hypothesis = marketQuote && (inLetter2 || (!withCase && template.bodyWithoutCase.includes(P.hypothesis)))
    ? await deps.hypothesis({ brand: input.brand, productSummary: input.productSummary, marketQuote })
    : null;
  const hypoText = hypothesis ? (inLetter2 ? siteObservationText(input.brand, hypothesis) : hypothesisText(input.brand, hypothesis)) : null;
  // Предмет обсуждения — только если шаблон его ставит (прежние шаблоны — нет).
  const allBodies = [template.bodyDirect, template.bodyRouting, template.letter2].join('\n');
  const topic = allBodies.includes(P.topic) ? (await deps.topic(input.productSummary)) ?? FALLBACK_TOPIC : FALLBACK_TOPIC;
  const position = input.chain === 'hiring' && input.primary?.title?.trim() ? `«${input.primary.title.trim()}»` : null;

  const values: TemplateValues = {
    brand: input.brand,
    opening,
    bridge,
    caseText: withCase ? caseText : null,
    hypothesis: hypoText,
    signature: formatSignature(deps.sender),
    isRouting: input.isRouting,
    topic,
    position,
  };
  const rendered = renderTemplate(template, values);
  // Второй вариант письма 1 — тот вид, которого нет у главного адреса: у
  // компании есть и адрес отдела, и общий ящик. Письма 2–4 и тема общие.
  const alt = input.alt && input.alt.isRouting !== input.isRouting ? input.alt : null;
  const altLetter1 = alt ? renderTemplate(template, { ...values, isRouting: alt.isRouting })[0] : null;
  const letters: Letter[] = alt && altLetter1
    ? [{ ...rendered[0], alt_body: altLetter1.body, alt_routing: alt.isRouting }, ...rendered.slice(1)]
    : rendered;
  const text = [...rendered.map((l) => `${l.subject}\n${l.body}`), ...(altLetter1 ? [altLetter1.body] : [])].join('\n');
  const used = claimsForChain(deps.claims, input.chain).filter((c) => c.claim_text.trim() && text.includes(c.claim_text.trim()));
  const qaInput = {
    expectedLetters: letterCountFor(input.chain),
    amoStatus: input.amoStatus,
    sender: deps.sender,
    priorContact: input.priorContact,
    caseText: withCase ? caseText : null,
    claimTexts: used.map((c) => c.claim_text),
    allowedFacts: [
      input.brand,
      // Отправитель представляется в письмах 2–3 текстом шаблона.
      deps.sender.company_name,
      ...(opening ? [opening] : []),
      topic,
      ...(position ? [position] : []),
      ...input.signals.flatMap((s) => [s.title, s.quote ?? '']).filter(Boolean),
      ...(marketQuote ? [marketQuote] : []),
    ],
    targetMarket: input.targetMarket,
    marketQuote,
  };
  const mainQa = runQa({ ...qaInput, letters: rendered, recipientEmail: input.recipientEmail });
  // Второй вариант проверяется теми же правилами: его получит живой адрес
  // компании. Провал любого — строка на ручную проверку; флаги второго
  // варианта — с приставкой alt:.
  const altQa = alt && altLetter1
    ? runQa({ ...qaInput, letters: [altLetter1, ...rendered.slice(1)], recipientEmail: alt.recipientEmail })
    : null;
  const altFlags = (altQa?.flags ?? []).filter((flag) => !mainQa.flags.includes(flag)).map((flag) => `alt:${flag}`);
  const qa: QaResult = altQa
    ? { status: mainQa.status === 'passed' && altQa.status === 'passed' ? 'passed' : 'failed', flags: [...mainQa.flags, ...altFlags] }
    : mainQa;
  return {
    letters,
    qa,
    caseId: withCase ? input.caseRecord?.case_id ?? null : null,
    hypothesisText: hypoText,
    claimIds: used.map((c) => c.id),
  };
}

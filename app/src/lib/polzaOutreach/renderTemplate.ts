/**
 * Письма компании из шаблона цепочки оффера английского аутрича (спека
 * 2026-09-26-outreach-to-sender-design.md §4).
 *
 * Шаблон пишет писатель один раз на оффер (templateWriter.ts); здесь под
 * компанию подставляются только проверенные факты: название, фраза-повод
 * (triggerPhrase — детерминированная, из подтверждённого повода), короткий
 * повод, боль компании из разбора сайта ({{pain}}, 29.09.2026 вместо строки
 * «что компания делает» {{about}}), предложение об утверждённом кейсе, первые
 * сегменты из разбора сайта и подпись из настроек. Выбор вариантов: письмо 1
 * лично (sales@, личный адрес) или «прислать тому, кто отвечает за продажи?»
 * (общий ящик), письмо 3 с кейсом или без.
 * Строка с пустым значением удаляется целиком — как пустой абзац у прежней
 * цепочки (signed()).
 *
 * Готовые письма проверяет guardLetters, как и раньше: шаблон проверен до
 * подстановки (guardTemplate), но подставленные факты — нет.
 */

import { caseSentence, displayName, guardLetters, letterCompanyName, segmentsBlock, shortJobTitle, triggerPhrase, triggerShort } from './buildLetters';
import type { EnCase } from './caseRouter';
import { primaryTrigger, type Trigger } from './leadScore';
import {
  POLZA_TEMPLATE_PLACEHOLDERS,
  type PolzaChainTemplateLetters,
  type PolzaLetterGuardResult,
  type PolzaOfferKey,
  type PolzaOutreachLetter,
} from './types';

const P = POLZA_TEMPLATE_PLACEHOLDERS;
const ANY_PLACEHOLDER = /\{\{[^{}]*\}\}/g;
/**
 * Строка о компании из шаблонов до 29.09.2026. Шаблоны старых запусков не
 * переписываем: их {{about}} убирается вместе со своим абзацем, как пустое
 * значение, — иначе гард писем бракует «остались переменные».
 */
const LEGACY_ABOUT = '{{about}}';

/** Оффер компании — тип её главного повода; без повода — none. */
export function offerKeyOf(primary: Trigger | null): PolzaOfferKey {
  return primary?.type ?? 'none';
}

export interface TemplateValues {
  company: string;
  /** Фраза-повод (triggerPhrase); нет — строка с {{trigger}} удаляется. */
  trigger: string | null;
  triggerShort: string;
  /** Боль компании (siteProfile.painLine); нет — строка с {{pain}} удаляется. */
  pain: string | null;
  /** Предложение о кейсе (caseSentence); есть — письмо 3 с кейсом. */
  caseText: string | null;
  /** Блок сегментов (segmentsBlock); нет — строка удаляется. */
  segments: string | null;
  /** Подпись из настроек целиком. */
  signature: string;
  /** Общий ящик: письмо 1 — «кто у вас за это отвечает?». */
  isRouting: boolean;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fill(text: string, values: Record<string, string | null>): string {
  let out = text;
  // Пустое значение убирает свою строку целиком: плейсхолдер-предложение стоит
  // отдельной строкой (это проверяет guardTemplate).
  for (const [placeholder, value] of Object.entries(values)) {
    if (!value) out = out.replace(new RegExp(`^[ \\t]*${escapeRe(placeholder)}[ \\t]*(?:\\n|$)`, 'gm'), '');
  }
  // Один проход: подставленный текст (кейс, сегменты) заново не разбирается.
  // Незнакомый плейсхолдер остаётся как есть — его поймает guardLetters.
  out = out.replace(ANY_PLACEHOLDER, (found) => (found in values ? values[found] ?? '' : found));
  // Абзацы без пустых, как у прежней цепочки.
  return out
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .join('\n\n');
}

function renderBody(body: string, values: Record<string, string | null>, signature: string): string {
  const text = body.replace(/\r\n?/g, '\n').trimEnd();
  if (!text.endsWith(P.signature)) return fill(text, values);
  // Подпись — последним абзацем и ровно как в настройках: guardLetters
  // сверяет конец письма с ней посимвольно, а fill мог бы поправить её
  // пустые строки.
  return `${fill(text.slice(0, -P.signature.length), values)}\n\n${signature}`;
}

/** Шаблон → четыре письма компании. Тема — только у письма 1: письма 2–4 идут ответом в той же ветке. */
export function renderTemplate(template: PolzaChainTemplateLetters, v: TemplateValues): PolzaOutreachLetter[] {
  const values: Record<string, string | null> = {
    [P.company]: v.company,
    [P.trigger]: v.trigger,
    [P.triggerShort]: v.triggerShort,
    [P.pain]: v.pain,
    [LEGACY_ABOUT]: null,
    [P.case]: v.caseText,
    [P.segments]: v.segments,
    [P.signature]: v.signature,
  };
  const subject = template.subject
    .replace(ANY_PLACEHOLDER, (found) => (found === P.company ? v.company : found))
    .replace(/\s+/g, ' ')
    .trim();
  return [
    { n: 1, subject, body: renderBody(v.isRouting ? template.bodyRouting : template.bodyDirect, values, v.signature) },
    { n: 2, subject: '', body: renderBody(template.letter2, values, v.signature) },
    { n: 3, subject: '', body: renderBody(v.caseText ? template.bodyWithCase : template.bodyWithoutCase, values, v.signature) },
    { n: 4, subject: '', body: renderBody(template.letter4, values, v.signature) },
  ];
}

/** Всё о компании, что нужно письмам: из разбора в раннере или из строки журнала («Переписать цепочку»). */
export interface CompanyLettersInput {
  /** Название как в источнике — в письма идёт без юрформы (displayName). */
  companyName: string;
  /** Название с сайта: заменяет слаг из адреса вакансии (letterCompanyName). */
  brandName?: string | null;
  /** Боль компании из разбора сайта — {{pain}}. */
  painLine?: string | null;
  /** Все подтверждённые поводы строки — главный среди них выбирает primaryTrigger. */
  triggers: Trigger[];
  /** Кейс по отрасли (routeEnCase); нет — письмо 3 без кейса. */
  caseHit: EnCase | null;
  /** Сегменты из разбора сайта. */
  segments: string[];
  /** Тип выбранной почты (findEmail): общий ящик получает письмо 1 «кто отвечает». */
  emailType: string | null;
  /**
   * Второй вариант письма 1 для остальных адресов компании (altRoutingFor):
   * true — «кто у вас за это отвечает?», false — лично; null — не нужен.
   */
  altRouting?: boolean | null;
}

export interface CompanyLetters {
  letters: PolzaOutreachLetter[];
  guard: PolzaLetterGuardResult;
  isRouting: boolean;
}

/**
 * Письма компании: значения плейсхолдеров, подстановка в шаблон и гарды
 * готовых писем. Одно правило для раннера и для «Переписать цепочку» — иначе
 * пересобранные письма проверялись бы не так, как обычные.
 */
export function composeCompanyLetters(template: PolzaChainTemplateLetters, input: CompanyLettersInput, signature: string): CompanyLetters {
  // Факты — в один пробел: гард сверяет разрешённые куски с текстом письма
  // посимвольно, а двойной пробел или перевод строки внутри названия,
  // должности или кейса (так бывает в источниках) разошёлся бы с письмом.
  const tidy = (text: string) => text.replace(/\s+/g, ' ').trim();
  const company = tidy(displayName(letterCompanyName(input.companyName, input.brandName)));
  const pain = input.painLine ? tidy(input.painLine) : null;
  const triggers = input.triggers.map((t) => ({ ...t, title: tidy(t.title) }));
  const caseHit = input.caseHit ? { ...input.caseHit, snippet: tidy(input.caseHit.snippet), segment: tidy(input.caseHit.segment) } : null;
  const primary = primaryTrigger(triggers);
  const isRouting = input.emailType === 'generic_company';
  const values: TemplateValues = {
    company,
    trigger: triggerPhrase(company, primary),
    triggerShort: triggerShort(primary),
    pain,
    caseText: caseHit ? caseSentence(caseHit) : null,
    segments: segmentsBlock(company, input.segments),
    signature,
    isRouting,
  };
  const letters = renderTemplate(template, values);
  // Второй вариант письма 1 — тот вид, которого нет у главного адреса: у
  // компании есть и личный адрес, и общий ящик. Письма 2–4 и тема общие.
  const altRouting = input.altRouting ?? null;
  const altLetter1 = altRouting !== null && altRouting !== isRouting ? renderTemplate(template, { ...values, isRouting: altRouting })[0] : null;
  // Проверенные факты: цифры в письмах — только из них, а запретные и служебные
  // слова гард ищет в тексте без них (имя «Leading Edge» — не наша реклама).
  // Сегменты и боль — из разбора сайта, цифр в них не бывает (siteProfile);
  // в боли законны слова вроде «LLM» и «evidence».
  const allowedFacts = [
    company,
    ...(pain ? [pain] : []),
    ...triggers.map((t) => t.title),
    // В фразу-повод идёт короткое название вакансии — его цифры тоже из факта.
    ...triggers.map((t) => (t.type === 'hiring' ? shortJobTitle(t.title) : null)).filter((s): s is string => Boolean(s)),
    ...(caseHit ? [caseHit.snippet, caseHit.segment] : []),
    ...input.segments.map(tidy),
  ];
  const guard = guardLetters(letters, allowedFacts, signature);
  if (!altLetter1) return { letters, guard, isRouting };
  // Второй вариант проверяется теми же гардами, что и основной: его получит
  // живой адрес компании. Провал любого — строка на ручную проверку.
  const altGuard = guardLetters([altLetter1, ...letters.slice(1)], allowedFacts, signature);
  const altLabel = altRouting ? 'вариант для общего ящика' : 'личный вариант';
  const altViolations = altGuard.violations
    .filter((v) => v.startsWith('письмо 1'))
    .map((v) => v.replace(/^письмо 1/, `письмо 1 (${altLabel})`));
  const [first, ...rest] = letters;
  return {
    letters: [{ ...first, alt_body: altLetter1.body, alt_routing: altRouting as boolean }, ...rest],
    guard: { ok: guard.ok && altViolations.length === 0, violations: [...guard.violations, ...altViolations] },
    isRouting,
  };
}

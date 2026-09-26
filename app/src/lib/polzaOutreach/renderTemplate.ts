/**
 * Письма компании из шаблона цепочки оффера английского аутрича (спека
 * 2026-09-26-outreach-to-sender-design.md §4).
 *
 * Шаблон пишет писатель один раз на оффер (templateWriter.ts); здесь под
 * компанию подставляются только проверенные факты: название, фраза-повод
 * (triggerPhrase — детерминированная, из подтверждённого повода), короткий
 * повод, предложение об утверждённом кейсе, первые сегменты из разбора сайта и
 * подпись из настроек. Выбор вариантов: письмо 1 лично (sales@, личный адрес)
 * или «кто у вас за это отвечает?» (общий ящик), письмо 3 с кейсом или без.
 * Строка с пустым значением удаляется целиком — как пустой абзац у прежней
 * цепочки (signed()).
 *
 * Готовые письма проверяет guardLetters, как и раньше: шаблон проверен до
 * подстановки (guardTemplate), но подставленные факты — нет.
 */

import { caseSentence, displayName, guardLetters, segmentsBlock, triggerPhrase, triggerShort } from './buildLetters';
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

/** Оффер компании — тип её главного повода; без повода — none. */
export function offerKeyOf(primary: Trigger | null): PolzaOfferKey {
  return primary?.type ?? 'none';
}

export interface TemplateValues {
  company: string;
  /** Фраза-повод (triggerPhrase); нет — строка с {{trigger}} удаляется. */
  trigger: string | null;
  triggerShort: string;
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
  /** Все подтверждённые поводы строки — главный среди них выбирает primaryTrigger. */
  triggers: Trigger[];
  /** Кейс по отрасли (routeEnCase); нет — письмо 3 без кейса. */
  caseHit: EnCase | null;
  /** Сегменты из разбора сайта. */
  segments: string[];
  /** Тип выбранной почты (findEmail): общий ящик получает письмо 1 «кто отвечает». */
  emailType: string | null;
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
  const company = tidy(displayName(input.companyName));
  const triggers = input.triggers.map((t) => ({ ...t, title: tidy(t.title) }));
  const caseHit = input.caseHit ? { ...input.caseHit, snippet: tidy(input.caseHit.snippet), segment: tidy(input.caseHit.segment) } : null;
  const primary = primaryTrigger(triggers);
  const isRouting = input.emailType === 'generic_company';
  const letters = renderTemplate(template, {
    company,
    trigger: triggerPhrase(company, primary),
    triggerShort: triggerShort(primary),
    caseText: caseHit ? caseSentence(caseHit) : null,
    segments: segmentsBlock(company, input.segments),
    signature,
    isRouting,
  });
  // Проверенные факты: цифры в письмах — только из них, а запретные и служебные
  // слова гард ищет в тексте без них (имя «Leading Edge» — не наша реклама).
  // Сегменты — из разбора сайта, цифр в них не бывает (siteProfile).
  const allowedFacts = [
    company,
    ...triggers.map((t) => t.title),
    ...(caseHit ? [caseHit.snippet, caseHit.segment] : []),
    ...input.segments.map(tidy),
  ];
  return { letters, guard: guardLetters(letters, allowedFacts, signature), isRouting };
}

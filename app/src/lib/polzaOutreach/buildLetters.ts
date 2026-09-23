/**
 * S6 — цепочка английского аутрича v2: четыре письма CEO
 * (en-outreach-flow-improvements §5, 23.09.2026). Заменила цепочку
 * «SDR hiring-trigger» от 11.09.2026 (гарантия «3 SQL или бесплатно» ушла
 * вместе с ней — в новой цепочке её нет).
 *
 *  1 — route to owner: повод + «кто отвечает за outbound?»;
 *  2 — боль и механика;
 *  3 — доказательство: утверждённый кейс (только при совпадении отрасли),
 *      гипотеза из 2–3 сегментов, предложение бесплатной выборки 20–30 компаний;
 *  4 — закрыть переписку.
 *
 * Одно письмо — одна мысль и один вопрос. Имени получателя у нас нет (почта
 * компании), поэтому обращение «Hi there,». Фразы-поводы — формулировки CEO,
 * поданные как наблюдение («looks like», «usually»), а не как факт.
 */

import type { EnCase } from './caseRouter';
import type { Trigger } from './leadScore';
import type { PolzaLetterGuardResult, PolzaOutreachLetter } from './types';

export const SIGNATURE = 'Julia Mira\nAccount Manager\nPolza Agency';
export const SEQUENCE_ID = 'en_trigger_router_v1';

export interface BuildLettersInput {
  company: string;
  trigger: Trigger | null;
  caseHit: EnCase | null;
  segments: string[];
}

const LEGAL_SUFFIX_RE = /[,\s]+(inc\.?|llc|l\.l\.c\.|ltd\.?|limited|gmbh|corp\.?|corporation|co\.|b\.v\.|bv|s\.a\.|ag|plc|pte\.?\s*ltd\.?)$/i;

/** Имя для писем: без юрформы, без изменения бренда. */
export function displayName(name: string): string {
  let out = name.trim();
  for (let i = 0; i < 2; i += 1) out = out.replace(LEGAL_SUFFIX_RE, '').trim();
  return out || name.trim();
}

/** Фраза-повод письма 1 (таблица «Trigger phrase examples» CEO). */
export function triggerPhrase(company: string, t: Trigger | null): string | null {
  if (!t) return null;
  switch (t.type) {
    case 'hiring':
      return `Saw that ${company} is hiring for ${t.title}, looks like outbound/GTM is becoming a priority.`;
    case 'yc':
      return `Saw ${company} was part of YC ${t.title}, usually this stage is about proving repeatable GTM fast.`;
    case 'launch':
      return `Saw the recent launch at ${company}, looks like the next step is finding the right first B2B accounts.`;
    case 'tech_stack':
      return 'Looks like your team already uses outbound/CRM tools, so the bottleneck is probably not sending but account selection.';
  }
}

export function triggerShort(t: Trigger | null): string {
  switch (t?.type) {
    case 'hiring':
      return 'hiring for GTM roles';
    case 'yc':
      return 'coming out of YC';
    case 'launch':
      return 'launching a new product';
    case 'tech_stack':
      return 'already running outbound tools';
    default:
      return 'looking for new B2B pipeline';
  }
}

function signed(...paragraphs: Array<string | null | undefined | false>): string {
  const body = paragraphs.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).join('\n\n');
  return `Hi there,\n\n${body}\n\n${SIGNATURE}`;
}

export function buildLetters(input: BuildLettersInput): PolzaOutreachLetter[] {
  const { company } = input;
  const phrase = triggerPhrase(company, input.trigger);
  const segments = input.segments.slice(0, 3);

  const letter1 = signed(
    phrase,
    'Usually at this stage the hard part is not sending more emails, but finding the right accounts, the right angle, and getting first qualified replies fast.',
    'We help B2B teams build the list, enrich contacts, write the sequence, and launch outbound without hiring an SDR just to do manual research.',
    'Who would be the right person to speak with about new B2B pipeline?',
  );

  const letter2 = signed(
    `The reason I reached out: when a team is ${triggerShort(input.trigger)}, the slow part is usually not the email tool.`,
    'It is:\n- which companies to target;\n- which contacts to use;\n- what angle to test first;\n- how to avoid a generic cold email.',
    'We handle that end-to-end: account research, contact enrichment, sequence writing, launch setup and reply tracking.',
    'Worth asking who owns this on your side?',
  );

  const letter3 = signed(
    input.caseHit ? `For a similar ${input.caseHit.segment} company, we helped ${input.caseHit.snippet}.` : null,
    segments.length >= 2
      ? `For ${company}, I would probably start with:\n${segments.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
      : null,
    'I can send a small sample of 20–30 accounts so you can judge the quality before any call.',
    'Should I send it here?',
  );

  const letter4 = signed(
    'Should I close the loop here?',
    `If outbound/new pipeline is relevant, I can send a small account sample for ${company}.\nIf not, just reply “not now” and I will not follow up.`,
  );

  return [
    { n: 1, subject: `who owns outbound at ${company}?`, body: letter1 },
    { n: 2, subject: 'quick follow-up', body: letter2 },
    { n: 3, subject: `example for ${company}`, body: letter3 },
    { n: 4, subject: 'should I close this?', body: letter4 },
  ];
}

// ── Гарды ──

const INTERNAL_RE = /\b(score|scoring|pipeline_stage|validation|pre-scoring|rerank|icp|llm|json|undefined|null|evidence|trigger_\w+)\b/i;
const HYPE_RE = /\b(leading|full-service|world-class|revolutionary|guarantee[sd]?|best-in-class)\b/i;
const TEMPLATE_NUMBERS = ['20–30', '20-30', 'B2B', '1. ', '2. ', '3. '];

/**
 * Детерминированные гарды: шаблон собран без хвостов, один вопрос на письмо,
 * подпись на месте, цифры только из утверждённого кейса и фактов повода.
 * Провал — строка needs_review, текст не «подправляется».
 */
export function guardLetters(letters: PolzaOutreachLetter[], allowedFacts: string[]): PolzaLetterGuardResult {
  const violations: string[] = [];
  if (letters.length !== 4) violations.push(`писем ${letters.length} вместо 4`);
  const pieces = [...allowedFacts, ...TEMPLATE_NUMBERS].filter(Boolean).sort((a, b) => b.length - a.length);

  letters.forEach((letter) => {
    const label = `letter ${letter.n}`;
    const text = `${letter.subject}\n${letter.body}`;
    if (!letter.body.startsWith('Hi there,')) violations.push(`${label}: обращение должно быть «Hi there,»`);
    if (!letter.body.endsWith(SIGNATURE)) violations.push(`${label}: подпись Julia Mira / Account Manager / Polza Agency`);
    if (/\{\{|\}\}/.test(text)) violations.push(`${label}: остались переменные`);
    const questions = (letter.body.match(/\?/g) ?? []).length;
    if (questions !== 1) violations.push(`${label}: вопросов ${questions}, нужен ровно один`);
    if (INTERNAL_RE.test(letter.body)) violations.push(`${label}: служебное слово в тексте`);
    if (HYPE_RE.test(text)) violations.push(`${label}: запрещённое слово`);
    let rest = letter.body;
    for (const p of pieces) rest = rest.split(p).join(' ');
    if (/\d/.test(rest)) violations.push(`${label}: число не из кейса и не из повода`);
  });

  return { ok: violations.length === 0, violations };
}

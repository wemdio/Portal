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
 *
 * С 26.09.2026 письма компаниям собираются из шаблона цепочки оффера, который
 * один раз на запуск пишет Gemini 3.1 Pro (templateWriter.ts, спека
 * 2026-09-26-outreach-to-sender-design.md §4). buildLetters остался образцом
 * тона и структуры для писателя: он получает эту цепочку собранной на
 * плейсхолдерах. Здесь же — значения плейсхолдеров под компанию (фраза-повод,
 * короткий повод, кейс, сегменты: одни и те же для образца и для писем),
 * гарды готовых писем (guardLetters) и проверка шаблона до подстановки
 * (guardTemplate).
 */

import type { EnCase } from './caseRouter';
import type { Trigger } from './leadScore';
import {
  POLZA_OUTREACH_DEFAULT_SIGNATURE,
  POLZA_TEMPLATE_PLACEHOLDERS,
  polzaTemplatePlaceholdersFor,
  type PolzaChainTemplateLetters,
  type PolzaLetterGuardResult,
  type PolzaOfferKey,
  type PolzaOutreachLetter,
} from './types';

/**
 * Версия писем строки (sequence_id). С 26.09.2026 письма — шаблон цепочки
 * оффера от писателя с подставленными фактами компании; прежняя
 * детерминированная цепочка (en_trigger_router_v1) — только его образец.
 */
export const SEQUENCE_ID = 'en_offer_templates_v1';

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

/** Фраза-повод письма 1 (таблица «Trigger phrase examples» CEO) — значение {{trigger}}. */
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

/** Повод для середины фразы («when a team is …») — значение {{trigger_short}}. */
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

/** Предложение об утверждённом кейсе — значение {{case}}. */
export function caseSentence(c: EnCase): string {
  return `For a similar ${c.segment} company, we helped ${c.snippet}.`;
}

/**
 * Первые сегменты для компании (из разбора сайта) со своей вводной строкой —
 * значение {{segments}}. Меньше двух — блока нет: один сегмент — не выбор.
 */
export function segmentsBlock(company: string, segments: string[]): string | null {
  const list = segments.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 3);
  if (list.length < 2) return null;
  return `For ${company}, I would probably start with:\n${list.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
}

function signed(...paragraphs: Array<string | null | undefined | false>): string {
  const body = paragraphs.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).join('\n\n');
  return `Hi there,\n\n${body}\n\n${POLZA_OUTREACH_DEFAULT_SIGNATURE}`;
}

/** Цепочка CEO — образец писателя шаблонов (templateWriter.ts собирает её на плейсхолдерах). */
export function buildLetters(input: BuildLettersInput): PolzaOutreachLetter[] {
  const { company } = input;
  const phrase = triggerPhrase(company, input.trigger);

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
    input.caseHit ? caseSentence(input.caseHit) : null,
    segmentsBlock(company, input.segments),
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

// ── Гарды готовых писем ──

const INTERNAL_RE = /\b(score|scoring|pipeline_stage|validation|pre-scoring|rerank|icp|llm|json|undefined|null|evidence|trigger_\w+)\b/i;
const HYPE_RE = /\b(leading|full-service|world-class|revolutionary|guarantee[sd]?|best-in-class)\b/i;
const TEMPLATE_NUMBERS = ['20–30', '20-30', 'B2B', '1. ', '2. ', '3. '];

/** Текст без разрешённых кусков — длинные первыми, чтобы кусок внутри длинного не разрезал его. */
function stripAll(text: string, pieces: string[]): string {
  let rest = text;
  for (const piece of pieces.filter(Boolean).sort((a, b) => b.length - a.length)) rest = rest.split(piece).join(' ');
  return rest;
}

/**
 * Детерминированные гарды готовых писем компании: без хвостов шаблона, один
 * вопрос на письмо, тема только у письма 1, подпись из настроек на месте, цифры
 * только из утверждённого кейса и фактов повода. Провал — строка
 * needs_review, текст не «подправляется».
 *
 * Подпись — текст оператора, а не письма: цифры телефона или «?» в ней письмо
 * неправильным не делают, поэтому правила текста проверяют то, что над ней.
 */
export function guardLetters(
  letters: PolzaOutreachLetter[],
  allowedFacts: string[],
  signature: string = POLZA_OUTREACH_DEFAULT_SIGNATURE,
): PolzaLetterGuardResult {
  const violations: string[] = [];
  if (letters.length !== 4) violations.push(`писем ${letters.length} вместо 4`);
  const pieces = [...allowedFacts, ...TEMPLATE_NUMBERS];

  letters.forEach((letter) => {
    const label = `письмо ${letter.n}`;
    const subject = letter.subject.trim();
    // Письма 2–4 — ответ в той же ветке: своя тема открыла бы новую переписку.
    if (letter.n === 1 && !subject) violations.push(`${label}: нет темы`);
    if (letter.n !== 1 && subject) violations.push(`${label}: у ответа в ветке не должно быть темы`);
    if (!letter.body.startsWith('Hi there,')) violations.push(`${label}: обращение должно быть «Hi there,»`);
    const hasSignature = letter.body.endsWith(signature);
    if (!hasSignature) violations.push(`${label}: в конце нет подписи из настроек`);
    const text = hasSignature ? letter.body.slice(0, -signature.length) : letter.body;
    if (/\{\{|\}\}/.test(`${letter.subject}\n${letter.body}`)) violations.push(`${label}: остались переменные`);
    const questions = (text.match(/\?/g) ?? []).length;
    if (questions !== 1) violations.push(`${label}: вопросов ${questions}, нужен ровно один`);
    if (INTERNAL_RE.test(text)) violations.push(`${label}: служебное слово в тексте`);
    if (HYPE_RE.test(`${letter.subject}\n${text}`)) violations.push(`${label}: запрещённое слово`);
    if (/\d/.test(stripAll(`${letter.subject}\n${text}`, pieces))) violations.push(`${label}: число не из кейса и не из повода`);
  });

  return { ok: violations.length === 0, violations };
}

// ── Режим шаблона ──

/** Проверка шаблона цепочки оффера до подстановки. */
export interface PolzaTemplateQaResult {
  ok: boolean;
  flags: string[];
}

const ANY_PLACEHOLDER = /\{\{[^{}]*\}\}/g;
const URGENCY_RE = /\b(act now|limited time|last chance|hurry|don['’]t miss|only \w+ (?:spots|slots) left)\b/i;
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const MARKDOWN_RE = /\*\*|__|^#{1,6}\s/m;
// Письмо 1 для общего ящика читает не ЛПР: оно обязано спросить, кто
// отвечает, или попросить переслать — иначе это то же прямое письмо.
const ROUTING_RE = /\b(right person|right contact|who (?:owns|handles|leads|runs|looks after|is responsible|would be)|point me|forward)\b/i;
const SUBJECT_MAX = 80;
// Шаблон идёт всем компаниям оффера, фактов о результатах у него нет: цифра в
// шаблоне — только размер бесплатной выборки, и только во фразе о выборке
// аккаунтов. «20–30» в другом месте читается уже как обещание.
const SAMPLE_SIZE_RE = /\b20\s?[–—-]\s?30(?=\s+(?:[a-z-]+\s+){0,2}(?:accounts|companies)\b)/gi;
const TEMPLATE_PIECES = ['B2B', '1. ', '2. ', '3. '];
// Обещания без цифр — те же выдуманные результаты: множители, доли, сроки,
// «сотни компаний».
const PROMISE_RE =
  /\b(?:twice|double[ds]?|doubling|triple[ds]?|tripling|dozens|hundreds|thousands|millions|percent|weeks?|months?)\b|\d+\s?%|\b\d+\s?x\b|\bx\s?\d+\b/i;
// С получателем мы не общались: письма 2–4 — продолжение нашего же письма, а
// «как мы обсуждали» в шаблоне уйдёт всем компаниям оффера.
const PRIOR_CONTACT_RE =
  /\b(?:as (?:we )?discussed|as promised|following up on (?:our|the) (?:call|conversation|chat|meeting|talk)|(?:when|since|after) we (?:spoke|talked|met)|we (?:spoke|talked|met)|our (?:last|previous|recent) (?:call|conversation|chat|meeting|talk)|(?:great|nice|good) (?:chatting|talking|speaking|meeting))\b/i;

function countOf(text: string, piece: string): number {
  return text.split(piece).length - 1;
}

/**
 * Плейсхолдер-предложение (повод, кейс, сегменты) стоит отдельной строкой:
 * пустое значение renderTemplate удаляет вместе со строкой, а в строке с
 * другим текстом осталась бы фраза без смысла.
 */
function standsAlone(text: string, placeholder: string): boolean {
  return text.split('\n').every((line) => !line.includes(placeholder) || line.trim() === placeholder);
}

function unsupportedNumbers(text: string): string[] {
  const rest = stripAll(text.replace(SAMPLE_SIZE_RE, ' '), TEMPLATE_PIECES);
  return Array.from(new Set(rest.match(/\S*\d\S*/g) ?? [])).slice(0, 3);
}

function firstMatch(re: RegExp, text: string): string | null {
  const m = re.exec(text);
  return m ? m[0].toLowerCase() : null;
}

/**
 * Правила guardLetters для шаблона цепочки оффера — один раз на оффер: шаблон
 * идёт всем компаниям оффера, и ошибка в нём повторилась бы в каждом письме.
 * Плюс правила самого шаблона: только плейсхолдеры оффера и на своих местах,
 * повод/кейс/сегменты — отдельной строкой, подпись — последней строкой, у
 * общего ящика — вопрос «кто у вас за это отвечает». Готовые письма компании
 * после подстановки проверяет guardLetters.
 *
 * Флаги — с местом: L1 — письмо 1 лично, L1r — для общего ящика, L2, L3c —
 * письмо 3 с кейсом, L3 — без кейса, L4, subject — тема письма 1.
 */
export function guardTemplate(t: PolzaChainTemplateLetters, offer: PolzaOfferKey): PolzaTemplateQaResult {
  const P = POLZA_TEMPLATE_PLACEHOLDERS;
  const flags: string[] = [];
  const allowed = new Set<string>(polzaTemplatePlaceholdersFor(offer));

  // Тема: из плейсхолдеров — только название компании.
  const subject = t.subject.trim();
  if (!subject) flags.push('subject_missing');
  else {
    const rest = subject.split(P.company).join(' ');
    if (/[{}]/.test(rest)) flags.push('subject_placeholder');
    if (subject.includes('!')) flags.push('subject_exclamation');
    if (subject.length > SUBJECT_MAX) flags.push('subject_too_long');
    if (HYPE_RE.test(rest) || URGENCY_RE.test(rest)) flags.push('subject:forbidden_word');
    if (INTERNAL_RE.test(rest)) flags.push('subject:internal_word');
    const promise = firstMatch(PROMISE_RE, rest);
    if (promise) flags.push(`subject:promise_words(${promise})`);
    if (PRIOR_CONTACT_RE.test(rest)) flags.push('subject:prior_contact');
    const digits = unsupportedNumbers(rest);
    if (digits.length) flags.push(`subject:unsupported_number(${digits.join(' ')})`);
  }

  const bodies: Array<[string, string]> = [
    ['L1', t.bodyDirect],
    ['L1r', t.bodyRouting],
    ['L2', t.letter2],
    ['L3c', t.bodyWithCase],
    ['L3', t.bodyWithoutCase],
    ['L4', t.letter4],
  ];
  const signOff = `\n\n${P.signature}`;
  for (const [tag, raw] of bodies) {
    const body = raw.trim();
    if (!body) {
      flags.push(`${tag}:empty`);
      continue;
    }
    if (!body.startsWith('Hi there,')) flags.push(`${tag}:greeting_missing`);
    const hasSignOff = body.endsWith(signOff);
    if (!hasSignOff) flags.push(`${tag}:signature_mismatch`);
    const text = hasSignOff ? body.slice(0, -signOff.length) : body;
    // Правила текста — без плейсхолдеров: «{{trigger_short}}» сам по себе
    // похож на служебное слово, а цифр и «?» в плейсхолдерах нет.
    const plain = text.replace(ANY_PLACEHOLDER, ' ');

    for (const found of new Set(text.match(ANY_PLACEHOLDER) ?? [])) {
      // Подпись — только последней строкой, её место проверено выше.
      if (!allowed.has(found) || found === P.signature) flags.push(`${tag}:placeholder_not_allowed(${found})`);
    }
    if (/[{}]/.test(plain)) flags.push(`${tag}:placeholder_broken`);
    for (const ph of [P.trigger, P.case, P.segments]) {
      if (countOf(text, ph) > 1) flags.push(`${tag}:placeholder_repeated(${ph})`);
      if (text.includes(ph) && !standsAlone(text, ph)) flags.push(`${tag}:placeholder_not_alone(${ph})`);
    }

    const questions = countOf(plain, '?');
    if (questions === 0) flags.push(`${tag}:no_cta`);
    if (questions > 1) flags.push(`${tag}:more_than_one_cta`);
    if (plain.includes('!')) flags.push(`${tag}:exclamation`);
    if (HYPE_RE.test(plain) || URGENCY_RE.test(plain)) flags.push(`${tag}:forbidden_word`);
    if (INTERNAL_RE.test(plain)) flags.push(`${tag}:internal_word`);
    if (EMOJI_RE.test(plain)) flags.push(`${tag}:emoji`);
    if (MARKDOWN_RE.test(text)) flags.push(`${tag}:markdown`);
    const promise = firstMatch(PROMISE_RE, plain);
    if (promise) flags.push(`${tag}:promise_words(${promise})`);
    if (PRIOR_CONTACT_RE.test(plain)) flags.push(`${tag}:prior_contact`);
    const digits = unsupportedNumbers(plain);
    if (digits.length) flags.push(`${tag}:unsupported_number(${digits.join(' ')})`);
  }

  // Обязательные плейсхолдеры и их места: повод — в письме 1 (оба варианта),
  // кейс — только в письме 3 с кейсом, сегменты — только в письме 3.
  if (allowed.has(P.trigger)) {
    if (!t.bodyDirect.includes(P.trigger)) flags.push(`L1:placeholder_missing(${P.trigger})`);
    if (!t.bodyRouting.includes(P.trigger)) flags.push(`L1r:placeholder_missing(${P.trigger})`);
  }
  if (!t.bodyWithCase.includes(P.case)) flags.push(`L3c:placeholder_missing(${P.case})`);
  if (!t.bodyWithoutCase.includes(P.segments)) flags.push(`L3:placeholder_missing(${P.segments})`);
  for (const [tag, raw] of bodies) {
    if (allowed.has(P.trigger) && !tag.startsWith('L1') && raw.includes(P.trigger)) flags.push(`${tag}:placeholder_misplaced(${P.trigger})`);
    if (tag !== 'L3c' && raw.includes(P.case)) flags.push(`${tag}:placeholder_misplaced(${P.case})`);
    if (!tag.startsWith('L3') && raw.includes(P.segments)) flags.push(`${tag}:placeholder_misplaced(${P.segments})`);
  }

  if (t.bodyRouting.trim() && !ROUTING_RE.test(t.bodyRouting.replace(ANY_PLACEHOLDER, ' '))) flags.push('L1r:not_routing');

  return { ok: flags.length === 0, flags };
}

type FlagLang = 'en' | 'ru';

const TEMPLATE_PLACES: Record<FlagLang, Record<string, string>> = {
  en: {
    L1: 'Email 1 (direct)',
    L1r: 'Email 1 (shared inbox)',
    L2: 'Email 2',
    L3c: 'Email 3 (with case)',
    L3: 'Email 3 (without case)',
    L4: 'Email 4',
    subject: 'Email 1 subject',
  },
  ru: {
    L1: 'Письмо 1 (лично)',
    L1r: 'Письмо 1 (общий ящик)',
    L2: 'Письмо 2',
    L3c: 'Письмо 3 (с кейсом)',
    L3: 'Письмо 3 (без кейса)',
    L4: 'Письмо 4',
    subject: 'Тема письма 1',
  },
};

const TEMPLATE_FLAG_TEXT: Record<FlagLang, Record<string, string>> = {
  en: {
    empty: 'the text is empty',
    letters_missing: 'the answer has no "letters" array with emails 1–4',
    greeting_missing: 'must start with the line "Hi there,"',
    signature_mismatch: 'must end with a blank line and then {{signature}} as the very last line',
    placeholder_not_allowed: 'this placeholder is not allowed here',
    placeholder_broken: 'broken placeholder: stray curly braces',
    placeholder_repeated: 'the placeholder appears twice',
    placeholder_not_alone: 'the placeholder must stand on its own line with no other text',
    placeholder_missing: 'a required placeholder is missing',
    placeholder_misplaced: 'the placeholder is in the wrong email',
    no_cta: 'no question — exactly one "?" is required',
    more_than_one_cta: 'more than one "?" — exactly one is required',
    exclamation: 'exclamation mark',
    forbidden_word: 'hype, guarantee or pressure wording',
    internal_word: 'internal words (score, ICP, LLM, JSON, null, evidence, validation)',
    emoji: 'emoji',
    markdown: 'markdown formatting',
    promise_words: 'multipliers, percentages, time frames or "hundreds/thousands" read as promises we cannot back',
    prior_contact: 'implies an earlier conversation — we have never talked to the recipient',
    unsupported_number: 'numbers — the only allowed one is "20–30" in the phrase about the free sample of accounts',
    not_routing: 'the shared-inbox variant must ask who the right person is or ask to forward the email',
    subject_missing: 'no subject',
    subject_placeholder: 'only {{company}} is allowed in the subject',
    subject_exclamation: 'exclamation mark',
    subject_too_long: `too long — keep it under ${SUBJECT_MAX} characters`,
  },
  ru: {
    empty: 'текст пустой',
    letters_missing: 'в ответе ИИ нет писем 1–4',
    greeting_missing: 'не начинается с «Hi there,»',
    signature_mismatch: 'подпись не последней строкой',
    placeholder_not_allowed: 'чужой плейсхолдер',
    placeholder_broken: 'сломанный плейсхолдер',
    placeholder_repeated: 'плейсхолдер стоит дважды',
    placeholder_not_alone: 'плейсхолдер не отдельной строкой',
    placeholder_missing: 'нет обязательного плейсхолдера',
    placeholder_misplaced: 'плейсхолдер не в том письме',
    no_cta: 'нет вопроса',
    more_than_one_cta: 'больше одного вопроса',
    exclamation: 'восклицательный знак',
    forbidden_word: 'реклама, гарантии или давление',
    internal_word: 'служебные слова',
    emoji: 'эмодзи',
    markdown: 'разметка markdown',
    promise_words: 'обещания результата или сроков',
    prior_contact: 'намёк на прошлый разговор',
    unsupported_number: 'цифры не из фразы о выборке 20–30 аккаунтов',
    not_routing: 'вариант для общего ящика не спрашивает, кто отвечает',
    subject_missing: 'нет темы',
    subject_placeholder: 'в теме плейсхолдер кроме {{company}}',
    subject_exclamation: 'восклицательный знак',
    subject_too_long: 'слишком длинная',
  },
};

/**
 * Флаг проверки шаблона словами: по-английски — для повторного запроса
 * писателю («Email 2: multipliers, … — 30%»), по-русски — для причины строки и
 * экрана («Письмо 2: обещания результата или сроков — 30%»). Незнакомый флаг —
 * как есть.
 */
export function describeTemplateFlag(flag: string, lang: FlagLang = 'en'): string {
  const places = TEMPLATE_PLACES[lang];
  const colon = flag.indexOf(':');
  const place = colon > 0 && places[flag.slice(0, colon)] ? flag.slice(0, colon) : null;
  const rest = place ? flag.slice(colon + 1) : flag;
  const paren = /^(.*?)\((.*)\)$/.exec(rest);
  const kind = paren ? paren[1] : rest;
  const detail = paren ? paren[2] : null;
  const where = place ? `${places[place]}: ` : kind.startsWith('subject_') ? `${places.subject}: ` : '';
  return `${where}${TEMPLATE_FLAG_TEXT[lang][kind] ?? kind}${detail ? ` — ${detail}` : ''}`;
}

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
  /** Строка о компании из разбора сайта (siteProfile.aboutLine) — значение {{about}}. */
  about?: string | null;
  caseHit: EnCase | null;
  segments: string[];
}

const LEGAL_SUFFIX_RE = /[,\s]+(inc\.?|llc|l\.l\.c\.|ltd\.?|limited|gmbh\s*&\s*co\.?\s*kg|gmbh|kg|ug|corp\.?|corporation|co\.|b\.v\.|bv|n\.v\.|nv|s\.a\.|s\.a\.s\.|sas|s\.r\.l\.|srl|ag|plc|oy|pty\.?\s*ltd\.?|pte\.?\s*ltd\.?)$/i;

/** Имя для писем: без юрформы, без изменения бренда. */
export function displayName(name: string): string {
  let out = name.trim();
  for (let i = 0; i < 2; i += 1) out = out.replace(LEGAL_SUFFIX_RE, '').trim();
  return out || name.trim();
}

/**
 * Имя компании для писем. Источник вакансий часто даёт имя из адреса вакансии
 * («ambiencehealthcare», «moss»), и письмо с ним выглядит собранным роботом.
 * Название с сайта (siteProfile.brandName) берём, когда исходное — такой
 * слаг (нет заглавных букв) или то же имя, только иначе написанное
 * («constellationspace» → «Constellation Space»). Разные имена («Alphabet» и
 * «Google») не подменяем: название с сайта может оказаться именем продукта.
 */
export function letterCompanyName(sourceName: string, brandName: string | null | undefined): string {
  const source = sourceName.trim();
  const brand = brandName?.trim();
  if (!brand) return source;
  const key = (s: string) => displayName(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!/[A-Z]/.test(source) || key(source) === key(brand)) return brand;
  return source;
}

/**
 * Название вакансии для письма: без скобок («(m/w/d)», «(Remote)»), локации и
 * отдела после « - », « | », « / », запятой. Длиннее шести слов — null: такое
 * название в письме выглядит вставленным роботом («Senior Vertriebsingenieur /
 * Business Development (m/w/d) Schlüsselfertiger Gewerbebau …»), и фраза-повод
 * обходится без него.
 */
export function shortJobTitle(title: string): string | null {
  const cut = title
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .split(/\s+[-–—|/]\s+|,\s+/)[0]
    .replace(/\s+/g, ' ')
    .trim();
  if (!cut || cut.length > 60 || cut.split(' ').length > 6) return null;
  return cut;
}

/**
 * Варианты фразы-повода письма 1 — значение {{trigger}}. Раньше фраза была
 * одна на всех («…looks like outbound/GTM is becoming a priority.»), и сотня
 * писем оффера начиналась одинаково. Теперь это короткий факт без вывода —
 * вывод делает текст шаблона, — в нескольких формулировках.
 */
export function triggerPhraseVariants(company: string, t: Trigger | null): string[] {
  if (!t) return [];
  switch (t.type) {
    case 'hiring': {
      const title = shortJobTitle(t.title);
      if (!title) return [`Saw that ${company} is hiring for sales.`, `Noticed ${company} is growing its sales team.`];
      return [
        `Saw that ${company} is hiring for ${title}.`,
        `Noticed the ${title} opening at ${company}.`,
        `Came across the ${title} role at ${company}.`,
      ];
    }
    case 'yc':
      return [`Saw that ${company} went through YC ${t.title}.`, `Noticed ${company} is a YC ${t.title} company.`];
    case 'launch':
      return [`Saw the recent launch news on the ${company} site.`, `Noticed ${company} has just launched something new.`];
    case 'tech_stack':
      return [`Looks like ${company} already runs ${t.title}.`, `Noticed ${t.title} on the ${company} site.`];
  }
}

/** Устойчивый выбор варианта по компании: у одной компании фраза всегда одна и та же. */
function pickVariant<T>(key: string, variants: T[]): T | null {
  if (!variants.length) return null;
  let h = 0;
  for (const ch of key.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return variants[h % variants.length];
}

/** Фраза-повод письма 1 — значение {{trigger}}. */
export function triggerPhrase(company: string, t: Trigger | null): string | null {
  return pickVariant(company, triggerPhraseVariants(company, t));
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

/**
 * Предложение об утверждённом кейсе — значение {{case}}. Было «For a similar
 * {segment} company, we helped {snippet}» — а snippet сам начинается с того же
 * описания клиента, и выходило «for a similar custom software development
 * company, we helped a custom software development team».
 */
export function caseSentence(c: EnCase): string {
  return `One example: we helped ${c.snippet}.`;
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

/**
 * Цепочка — образец писателя шаблонов (templateWriter.ts собирает её на
 * плейсхолдерах). 28.09.2026 переписана: прежний текст CEO шёл почти дословно
 * во все письма («топорно и одинаково» — отзыв продаж). Смысл и порядок те же:
 * повод и строка о компании → почему буксует и что делаем → пример и
 * бесплатная выборка → закрыть переписку. Письма 2–4 — ответы в той же ветке:
 * своей темы у них нет.
 */
export function buildLetters(input: BuildLettersInput): PolzaOutreachLetter[] {
  const { company } = input;
  const phrase = triggerPhrase(company, input.trigger);

  const letter1 = signed(
    phrase,
    input.about,
    `When a team is ${triggerShort(input.trigger)}, most of the early effort goes into research: which accounts to go after, who to contact there and what to say to them. That is the part we take on — the account list, contacts, the sequence and the launch — and the interested replies go straight to your team.`,
    'Who would be the right person to talk to about this?',
  );

  const letter2 = signed(
    'Following up on my note. Outbound rarely stalls because of the sending tool. It stalls because the same generic email goes to a broad list, and nobody has a real reason to reply.',
    `What we would do for ${company} instead: a few narrow segments, a separate reason to write to each company, and every reply handed to you with the full thread.`,
    'Would it help if I sketched what that could look like for you?',
  );

  const letter3 = signed(
    input.caseHit ? caseSentence(input.caseHit) : null,
    segmentsBlock(company, input.segments),
    `I can put together a free sample of 20–30 target accounts for ${company}, so you can judge the quality before we even talk.`,
    'Want me to send it over?',
  );

  const letter4 = signed(
    `Last note from me. If new pipeline is on the agenda at ${company}, the account sample is still on the table. If not, a short “not now” is enough and I will leave it there.`,
    'Should I close the loop?',
  );

  return [
    { n: 1, subject: `pipeline at ${company}`, body: letter1 },
    { n: 2, subject: '', body: letter2 },
    { n: 3, subject: '', body: letter3 },
    { n: 4, subject: '', body: letter4 },
  ];
}

// ── Гарды готовых писем ──

const INTERNAL_RE = /\b(score|scoring|pipeline_stage|validation|pre-scoring|rerank|icp|llm|json|undefined|null|evidence|trigger_\w+)\b/i;
const HYPE_RE = /\b(leading|full-service|world-class|revolutionary|guarantee[sd]?|best-in-class)\b/i;
const TEMPLATE_NUMBERS = ['B2B', '1. ', '2. ', '3. '];
/**
 * Размер бесплатной выборки — «20–30» с любым тире и пробелами, «20 to 30».
 * Писатель пишет его по-разному; normalizeSampleRange приводит шаблон к
 * «20–30», а гард писем принимает любую запись — проверки шаблона и писем
 * компании не расходятся.
 */
const SAMPLE_RANGE_ANY = /\b20\s*(?:[–—-]|to)\s*30\b/gi;

/** «20-30», «20 — 30», «20 to 30» → «20–30»: одна запись для проверки шаблона и писем. */
export function normalizeSampleRange(text: string): string {
  return text.replace(SAMPLE_RANGE_ANY, '20–30');
}

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
 * Так же и проверенные факты (название, должность, кейс, сегменты): «Leading
 * Edge Robotics» — имя компании, а не наша реклама, поэтому запретные и
 * служебные слова ищем в тексте без них.
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
    const ownWords = stripAll(`${letter.subject}\n${text}`, allowedFacts);
    if (INTERNAL_RE.test(stripAll(text, allowedFacts))) violations.push(`${label}: служебное слово в тексте`);
    if (HYPE_RE.test(ownWords)) violations.push(`${label}: запрещённое слово`);
    if (/\d/.test(stripAll(`${letter.subject}\n${text}`.replace(SAMPLE_RANGE_ANY, ' '), pieces))) {
      violations.push(`${label}: число не из кейса и не из повода`);
    }
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
// отвечает, или попросить переслать письмо. Голое «forward» не в счёт — «move
// forward», «look forward» так же пропустили бы прямое письмо.
const ROUTING_RE =
  /\b(?:right person|right people|right contact|who (?:owns|handles|leads|runs|looks after|is responsible|would be the right)|point me to|forward (?:this|it|my (?:note|email|message))|pass (?:this|it) (?:on|along))\b/i;
const SUBJECT_MAX = 80;
// Шаблон идёт всем компаниям оффера, фактов о результатах у него нет: цифра в
// шаблоне — только размер бесплатной выборки, и только во фразе о выборке
// аккаунтов («20–30 accounts», «20–30 B2B accounts»). «20–30» в другом месте
// читается уже как обещание. Шаблон к этой минуте прошёл normalizeSampleRange.
const SAMPLE_SIZE_RE = /\b20–30(?=\s+(?:[a-z0-9-]+\s+){0,2}(?:accounts|companies)\b)/gi;
// Обещания без цифр — те же выдуманные результаты: множители, доли, «сотни
// компаний», число встреч и сроки результата. Сроки — только как обещание
// («in two weeks», «within a month», «by next quarter»): «next week» для
// созвона и «double-check» обещаниями не считаются.
const NUMBER_WORD = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
const PROMISE_RE = new RegExp(
  [
    `\\b(?:in|within|over|after|under)\\s+(?:the\\s+)?(?:next\\s+|first\\s+)?(?:(?:a\\s+)?(?:couple\\s+of|few)|${NUMBER_WORD}|a|an|\\d+)\\s+(?:days?|weeks?|months?|quarters?|years?)\\b`,
    '\\bby\\s+(?:the\\s+)?(?:next|end\\s+of\\s+(?:the\\s+|this\\s+|next\\s+)?)\\s*(?:week|month|quarter|year)\\b',
    '\\b(?:twice|double[ds]?(?!-)|doubling|triple[ds]?|tripling|tenfold|(?:two|three|four|five|ten|\\d+)-?fold|dozens?|hundreds|thousands|millions|percent|per\\s+cent)\\b',
    '\\b(?:in|by)\\s+half\\b|\\bhalf\\s+the\\s+(?:time|cost|price|effort|work)\\b',
    `\\b(?:${NUMBER_WORD}|a\\s+dozen)\\s+(?:new\\s+|more\\s+|extra\\s+|qualified\\s+)?(?:meetings?|deals?|leads?|replies|responses|clients?|customers?|opportunities|sqls?|mqls?)\\b`,
    '\\d+\\s?%',
    '\\b\\d+\\s?x\\b',
    '\\bx\\s?\\d+\\b',
  ].join('|'),
  'i',
);
// С получателем мы не общались: письма 2–4 — продолжение нашего же письма, а
// «как мы обсуждали» в шаблоне уйдёт всем компаниям оффера.
const PRIOR_CONTACT_RE =
  /\b(?:as (?:we )?discussed|as promised|following up on (?:our|the) (?:call|conversation|chat|meeting|talk)|(?:when|since|after) we (?:spoke|talked|met)|we (?:spoke|talked|met)|our (?:last|previous|recent) (?:call|conversation|chat|meeting|talk)|(?:great|nice|good) (?:chatting|talking|speaking|meeting))\b/i;

function countOf(text: string, piece: string): number {
  return text.split(piece).length - 1;
}

/**
 * Плейсхолдер-предложение (повод, кейс, сегменты) — отдельным абзацем: пустое
 * значение renderTemplate удаляет его строку, а текст того же абзаца остался
 * бы с дырой.
 */
function ownParagraph(text: string, placeholder: string): boolean {
  const lines = text.split('\n');
  return lines.every((line, i) => {
    if (!line.includes(placeholder)) return true;
    if (line.trim() !== placeholder) return false;
    return !(lines[i - 1] ?? '').trim() && !(lines[i + 1] ?? '').trim();
  });
}

/**
 * Вводная строка перед плейсхолдером («Here is what I would test:»): у пустого
 * значения она повисла бы без продолжения. У {{segments}} вводная своя,
 * внутри значения.
 */
function hasLeadIn(text: string, placeholder: string): boolean {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => line.trim() === placeholder);
  let prev = at - 1;
  while (prev >= 0 && !lines[prev].trim()) prev -= 1;
  return prev >= 0 && /:\s*$/.test(lines[prev]);
}

function unsupportedNumbers(text: string): string[] {
  const rest = stripAll(text.replace(SAMPLE_SIZE_RE, ' '), TEMPLATE_NUMBERS);
  return Array.from(new Set(rest.match(/\S*\d\S*/g) ?? [])).slice(0, 3);
}

function firstMatch(re: RegExp, text: string): string | null {
  const m = re.exec(text);
  return m ? m[0].toLowerCase().replace(/\s+/g, ' ') : null;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Первый пример из задания, попавший в текст: слово — целиком, фраза — где угодно, без учёта регистра. */
function exampleLeak(text: string, examples: readonly string[]): string | null {
  for (const example of examples) {
    const re = /\s/.test(example.trim()) ? new RegExp(escapeRe(example.trim()), 'i') : new RegExp(`\\b${escapeRe(example.trim())}\\b`, 'i');
    if (example.trim() && re.test(text)) return example.trim();
  }
  return null;
}

/**
 * Правила guardLetters для шаблона цепочки оффера — один раз на оффер: шаблон
 * идёт всем компаниям оффера, и ошибка в нём повторилась бы в каждом письме.
 * Плюс правила самого шаблона: только плейсхолдеры оффера и на своих местах,
 * повод/кейс/сегменты — отдельным абзацем без вводной строки, подпись —
 * последней строкой, у общего ящика — вопрос «кто у вас за это отвечает»,
 * ничего из примеров задания (examples: компания Acme, должности и фразы
 * примеров повода — templateWriter.templateQaExamples). Готовые письма
 * компании после подстановки проверяет guardLetters.
 *
 * Флаги — с местом: L1 — письмо 1 лично, L1r — для общего ящика, L2, L3c —
 * письмо 3 с кейсом, L3 — без кейса, L4, subject — тема письма 1.
 */
export function guardTemplate(t: PolzaChainTemplateLetters, offer: PolzaOfferKey, examples: readonly string[] = []): PolzaTemplateQaResult {
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
    const leak = exampleLeak(rest, examples);
    if (leak) flags.push(`subject:example_leak(${leak})`);
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
    for (const ph of [P.trigger, P.about, P.case, P.segments]) {
      if (!text.includes(ph)) continue;
      if (countOf(text, ph) > 1) flags.push(`${tag}:placeholder_repeated(${ph})`);
      if (!ownParagraph(text, ph)) flags.push(`${tag}:placeholder_not_alone(${ph})`);
      else if (hasLeadIn(text, ph)) flags.push(`${tag}:placeholder_lead_in(${ph})`);
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
    const leak = exampleLeak(plain, examples);
    if (leak) flags.push(`${tag}:example_leak(${leak})`);
    const digits = unsupportedNumbers(plain);
    if (digits.length) flags.push(`${tag}:unsupported_number(${digits.join(' ')})`);
  }

  // Обязательные плейсхолдеры и их места: повод и строка о компании — в
  // письме 1 (оба варианта), кейс — только в письме 3 с кейсом, сегменты —
  // только в письме 3.
  if (allowed.has(P.trigger)) {
    if (!t.bodyDirect.includes(P.trigger)) flags.push(`L1:placeholder_missing(${P.trigger})`);
    if (!t.bodyRouting.includes(P.trigger)) flags.push(`L1r:placeholder_missing(${P.trigger})`);
  }
  if (!t.bodyDirect.includes(P.about)) flags.push(`L1:placeholder_missing(${P.about})`);
  if (!t.bodyRouting.includes(P.about)) flags.push(`L1r:placeholder_missing(${P.about})`);
  if (!t.bodyWithCase.includes(P.case)) flags.push(`L3c:placeholder_missing(${P.case})`);
  if (!t.bodyWithoutCase.includes(P.segments)) flags.push(`L3:placeholder_missing(${P.segments})`);
  for (const [tag, raw] of bodies) {
    if (allowed.has(P.trigger) && !tag.startsWith('L1') && raw.includes(P.trigger)) flags.push(`${tag}:placeholder_misplaced(${P.trigger})`);
    if (!tag.startsWith('L1') && raw.includes(P.about)) flags.push(`${tag}:placeholder_misplaced(${P.about})`);
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
    placeholder_not_alone: 'the placeholder must be its own paragraph: a blank line before and after, no other text',
    placeholder_lead_in: 'no lead-in line ending with ":" right before the placeholder — it would dangle when the value is empty',
    placeholder_missing: 'a required placeholder is missing',
    placeholder_misplaced: 'the placeholder is in the wrong email',
    no_cta: 'no question — exactly one "?" is required',
    more_than_one_cta: 'more than one "?" — exactly one is required',
    exclamation: 'exclamation mark',
    forbidden_word: 'hype, guarantee or pressure wording',
    internal_word: 'internal words (score, ICP, LLM, JSON, null, evidence, validation)',
    emoji: 'emoji',
    markdown: 'markdown formatting',
    promise_words: 'a promise we cannot back: multipliers or amounts (twice, 2x, tenfold, in half, hundreds, three meetings), percentages or time frames (in two weeks, within a month, by next quarter)',
    prior_contact: 'implies an earlier conversation — we have never talked to the recipient',
    example_leak: 'copied from the examples of this task (the company Acme, sample job titles or trigger phrases) — the template goes to every company',
    unsupported_number: 'numbers — the only allowed one is "20–30" in the phrase about the free sample of accounts',
    not_routing: 'the shared-inbox variant must ask who the right person is or ask to forward this email',
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
    placeholder_not_alone: 'плейсхолдер не отдельным абзацем',
    placeholder_lead_in: 'вводная строка перед плейсхолдером',
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
    example_leak: 'перенесён пример из задания',
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

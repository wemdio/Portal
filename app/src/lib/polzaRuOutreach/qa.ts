/**
 * Автоматический QA цепочки перед выгрузкой (правила RU §13, INSTRUCTION_02 §5,
 * INSTRUCTION_03 §6, дизайн §6).
 *
 * QA не переписывает письмо. Провал → строка manual_review с флагами. Допустима
 * только пересборка из другого утверждённого варианта, если это следует из
 * данных (evidence → generic), — это делает раннер, не QA.
 *
 * Цифры: любая цифра в письме должна прийти из разрешённого источника —
 * подписи, утверждённого кейса или claim, дословной цитаты, названия
 * компании/вакансии/выставки/контракта или фиксированных слов шаблона
 * («15 минут», «2–3 сегмента»). Остаток с цифрой = неподтверждённое число.
 *
 * Режим шаблона (runTemplateQa) — те же правила для шаблона цепочки оффера
 * до подстановки, один раз на оффер: писатель пишет шаблон на все компании
 * оффера, и ошибка в нём повторилась бы в каждом письме. Готовые письма
 * компании после подстановки проверяет обычный runQa.
 */

import { formatSignature, type SenderProfile } from './libraries';
import type { ChainTemplateLetters, ChainType, Letter, QaResult } from './types';
import {
  LETTER_COUNT,
  TEMPLATE_PLACEHOLDERS,
  TEMPLATE_SIGN_OFF,
  chainUsesCase,
  chainUsesHypothesis,
  templatePlaceholdersFor,
} from './types';

export interface QaInput {
  letters: Letter[];
  /** Сколько писем должно быть в цепочке: во всех цепочках четыре. */
  expectedLetters?: number;
  /** Статус компании в AMO: открытая сделка и клиент блокируют выгрузку. */
  amoStatus: string | null;
  sender: SenderProfile;
  priorContact: boolean;
  caseText: string | null;
  claimTexts: string[];
  /** Дословные цитаты и структурные поля, которые письмо может повторять. */
  allowedFacts: string[];
  /** Рынок, названный моделью: упоминается только при сверенной цитате рынка. */
  targetMarket: string | null;
  marketQuote: string | null;
  recipientEmail: string | null;
}

const TEMPLATE_NUMBERS = ['15 минут', '2–3', '2-3', 'B2B', 'b2b'];

const FORBIDDEN: Array<[RegExp, string]> = [
  [/срочн/i, 'forbidden:urgency'],
  [/уникальн/i, 'forbidden:unique'],
  [/гарантир/i, 'forbidden:guarantee'],
  [/последний шанс|предложение сгорает|осталось\s+\S+\s+мест/i, 'forbidden:scarcity'],
  [/мы лучшие|революцион/i, 'forbidden:superlative'],
  [/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'forbidden:emoji'],
  [/\bjson\b|```|\bundefined\b|\bnull\b|confidence|\bTODO\b/i, 'internal_text'],
  // Внутренняя кухня конвейера не должна утекать в письмо (RU_OUTREACH_HANDOFF §3.6).
  [/\b(score|scoring|pipeline|validation|pre-scoring|rerank|icp|llm|evidence|lead_score)\b|скоринг|ца-балл/i, 'internal_words'],
];

const CANDIDATE_LIKE_SUBJECT = /резюме|отклик|кандидат|соискател|ваканси[ияю]\s+[«"]?[^»"]{40,}/i;

function stripAll(text: string, pieces: string[]): string {
  let out = text;
  // Длинные куски первыми: название компании внутри фразы-сигнала не должно
  // разрушить совпадение самой фразы.
  for (const piece of [...pieces].sort((a, b) => b.length - a.length)) {
    if (piece && piece.trim()) out = out.split(piece).join(' ');
  }
  return out;
}

export function runQa(input: QaInput): QaResult {
  const flags: string[] = [];
  const expected = input.expectedLetters ?? LETTER_COUNT;
  if (input.letters.length !== expected) flags.push(`letter_count:${input.letters.length}/${expected}`);
  if (input.amoStatus === 'open_deal' || input.amoStatus === 'client') flags.push(`amo_blocked:${input.amoStatus}`);
  if (!input.recipientEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.recipientEmail)) flags.push('email_invalid');

  const signature = `С уважением,\n${formatSignature(input.sender)}`;
  const first = input.letters[0];
  if (!first?.subject?.trim()) flags.push('subject_missing');
  else {
    if (CANDIDATE_LIKE_SUBJECT.test(first.subject)) flags.push('subject_candidate_like');
    if (/[A-ZА-ЯЁ]{6,}/.test(first.subject.replace(/«[^»]*»/g, ''))) flags.push('subject_caps');
    if (/[!]/.test(first.subject)) flags.push('subject_exclamation');
  }

  const bodyWords: number[] = [];
  for (const letter of input.letters) {
    const tag = `L${letter.n}`;
    const body = letter.body ?? '';
    if (!body.endsWith(signature)) flags.push(`${tag}:signature_mismatch`);
    const text = body.endsWith(signature) ? body.slice(0, -signature.length) : body;
    bodyWords.push(text.trim().split(/\s+/).filter(Boolean).length);

    if (/\{\{|\}\}/.test(body)) flags.push(`${tag}:placeholder_left`);
    const questions = (text.match(/\?/g) ?? []).length;
    if (questions > 1) flags.push(`${tag}:more_than_one_cta`);
    const exclamations = text.replace(/^Добрый день!/, '').match(/!/g) ?? [];
    if (exclamations.length) flags.push(`${tag}:exclamation`);
    for (const [re, flag] of FORBIDDEN) if (re.test(text)) flags.push(`${tag}:${flag}`);
    if (/уже общались/i.test(text) && !input.priorContact) flags.push(`${tag}:false_prior_contact`);
    if (input.targetMarket && !input.marketQuote && text.toLowerCase().includes(input.targetMarket.toLowerCase())) {
      flags.push(`${tag}:market_without_evidence`);
    }

    const rest = stripAll(text, [
      ...(input.caseText ? [input.caseText] : []),
      ...input.claimTexts,
      ...input.allowedFacts,
      ...TEMPLATE_NUMBERS,
    ]);
    if (/\d/.test(rest)) flags.push(`${tag}:unsupported_number`);
  }

  if (input.caseText && !input.letters.some((l) => l.body.includes(input.caseText as string))) {
    flags.push('case_text_mismatch');
  }

  if (bodyWords.length === 4) {
    if (!(bodyWords[3] < bodyWords[1] && bodyWords[3] < bodyWords[2])) flags.push('L4:not_shortest');
  }

  return { status: flags.length ? 'failed' : 'passed', flags };
}

/* ─────────────────────────── Режим шаблона ─────────────────────────── */

export interface TemplateQaInput {
  letters: ChainTemplateLetters;
  chain: ChainType;
  /** Утверждённые формулировки оффера: цифры в шаблоне — только из них, дословно. */
  claimTexts: string[];
  /**
   * Имя и компания отправителя, как он представляется в письмах 2–3: они
   * постоянны на весь запуск и стоят в шаблоне текстом, а цифра в названии
   * компании — не выдуманное число.
   */
  senderTexts: string[];
  /**
   * Примеры из промпта — бренд-пример и примеры {{повод}}: в шаблоне это была
   * бы чужая компания в письме всем компаниям оффера.
   */
  exampleTexts?: string[];
}

const ANY_PLACEHOLDER = /\{\{[^{}]*\}\}/g;
const QUOTED_BRAND = `«${TEMPLATE_PLACEHOLDERS.brand}»`;
/**
 * «2–3» в шаблоне — только перед словом «сегмент» («2–3 сегмента», «2–3
 * узких сегмента»), как в образце CEO. У готовых писем «2–3» просто в списке
 * разрешённых слов, а в шаблоне писатель мог бы написать «2–3 недели» или
 * «2–3 клиента» — и это ушло бы всем компаниям оффера.
 */
const SEGMENTS_RANGE = /2\s*[–-]\s*3(?:\s+[^\s\d]+)?\s+сегмент/gi;
const TEMPLATE_ALLOWED_WORDS = ['15 минут', 'B2B', 'b2b'];
/**
 * Выдумки без цифр: числа словами и обещания сроков и результатов. Шаблон
 * идёт всем компаниям оффера, подтвердить такое в нём нечем. Готовые письма
 * (runQa) этого не проверяют: там это законно приходит из кейса.
 */
const FABRICATION = /(?<![а-яё])в\s+(?:\S+\s+)?раз[аы]?(?![а-яё])|вдвое|втрое|вчетверо|десятк|сотн|сотен|тысяч|процент|недел|месяц|месяч|квартал/gi;
/**
 * Намёк на прошлый контакт — не только «уже общались»: «ранее обсуждали»,
 * «с вами переписывались», «наш разговор», «нашей встречи».
 */
const PRIOR_CONTACT =
  /(?<![а-яё])(?:уже|ранее|раньше|с\s+вами)\s+(?:[а-яё]+\s+)?(?:общались|обсуждали|переписывались|созванивались|говорили)|(?<![а-яё])наш(?:ему|его|ей|ем|им|у|а|и)?\s+(?:прошл[а-яё]*\s+|недавн[а-яё]*\s+|последн[а-яё]*\s+)?(?:разговор|созвон|встреч|переписк)/i;
/** «Гарантий» и «гарантия» — тоже нет: промпт запрещает корень целиком, даже с отрицанием. */
const TEMPLATE_FORBIDDEN_EXTRA: Array<[RegExp, string]> = [[/гарант/i, 'forbidden:guarantee']];
/** Абзацы шаблона — через пустую строку, как у renderTemplate. */
const PARAGRAPH_BREAK = /\n[ \t]*\n/;

function countOf(text: string, piece: string): number {
  return text.split(piece).length - 1;
}

/** Первые куски текста с цифрами, которых нет в разрешённых источниках. */
function unsupportedNumbers(text: string, allowed: string[]): string[] {
  const rest = stripAll(text, allowed);
  return Array.from(new Set(rest.match(/\S*\d\S*/g) ?? [])).slice(0, 3);
}

/**
 * Необязательный плейсхолдер (повод, гипотеза) — отдельным абзацем: пустое
 * значение renderTemplate удаляет вместе с абзацем, а в абзаце с другим
 * текстом осталась бы фраза без смысла («Например: »). Гипотеза к тому же сама
 * из нескольких абзацев и внутри чужого абзаца слиплась бы с ним.
 */
function ownParagraph(text: string, placeholder: string): boolean {
  return text.split(PARAGRAPH_BREAK).every((p) => !p.includes(placeholder) || p.trim() === placeholder);
}

/**
 * Проверки текста, который пишет сам писатель: плейсхолдеры, утверждённые
 * формулировки и представление отправителя из него вычитаются — их цифры и
 * слова законны.
 */
function textChecks(tag: string, text: string, chain: ChainType, writerFree: string[], examples: string[], flags: string[]): void {
  const own = stripAll(text.replace(ANY_PLACEHOLDER, ' '), writerFree);
  for (const [re, flag] of [...FORBIDDEN, ...TEMPLATE_FORBIDDEN_EXTRA]) {
    if (re.test(own) && !flags.includes(`${tag}:${flag}`)) flags.push(`${tag}:${flag}`);
  }
  const digits = unsupportedNumbers(own.replace(SEGMENTS_RANGE, ' '), TEMPLATE_ALLOWED_WORDS);
  if (digits.length) flags.push(`${tag}:unsupported_number(${digits.join(' ')})`);
  const made = Array.from(new Set((own.match(FABRICATION) ?? []).map((m) => m.toLowerCase()))).slice(0, 3);
  if (made.length) flags.push(`${tag}:fabrication(${made.join(', ')})`);
  // Прошлый контакт — только «Возврату»: у остальных офферов разговор в AMO,
  // если он был, приносит {{повод}}, а текст шаблона идёт всем компаниям.
  if (chain !== 'reactivation' && PRIOR_CONTACT.test(own)) flags.push(`${tag}:false_prior_contact`);
  const lower = text.toLowerCase();
  const leaked = examples.find((e) => e.trim() && lower.includes(e.trim().toLowerCase()));
  if (leaked) flags.push(`${tag}:example_leak(${leaked.slice(0, 40)})`);
}

/**
 * Проверка шаблона цепочки оффера до подстановки. Флаги — те же слова, что у
 * runQa, с местом: L1 — письмо 1 лично, L1r — «перешлите ответственному»,
 * L2, L3c — письмо 3 с кейсом, L3 — без кейса, L4, subject — тема письма 1.
 */
export function runTemplateQa(input: TemplateQaInput): QaResult {
  const { letters: t, chain } = input;
  const P = TEMPLATE_PLACEHOLDERS;
  const flags: string[] = [];
  const allowed = new Set<string>(templatePlaceholdersFor(chain));
  const writerFree = [...input.claimTexts, ...input.senderTexts];
  const examples = input.exampleTexts ?? [];

  // Тема: из плейсхолдеров — только бренд, и в ёлочках: бренд капсом
  // («СИБУР») иначе провалил бы subject_caps у писем каждой такой компании.
  const subject = t.subject.trim();
  if (!subject) flags.push('subject_missing');
  else {
    const rest = subject.split(QUOTED_BRAND).join(' ');
    if (/[{}]/.test(rest)) flags.push(rest.includes(P.brand) ? 'subject_brand_unquoted' : 'subject_placeholder');
    if (CANDIDATE_LIKE_SUBJECT.test(rest)) flags.push('subject_candidate_like');
    if (/[A-ZА-ЯЁ]{6,}/.test(rest.replace(/«[^»]*»/g, ''))) flags.push('subject_caps');
    if (/!/.test(subject)) flags.push('subject_exclamation');
    textChecks('subject', rest, chain, writerFree, examples, flags);
  }

  const bodies: Array<[string, string]> = [
    ['L1', t.bodyDirect],
    ['L1r', t.bodyRouting],
    ['L2', t.letter2],
    ...(chainUsesCase(chain) ? [['L3c', t.bodyWithCase ?? ''] as [string, string]] : []),
    ['L3', t.bodyWithoutCase],
    ['L4', t.letter4],
  ];
  const words = new Map<string, number>();
  for (const [tag, raw] of bodies) {
    const body = raw.trim();
    if (!body) {
      flags.push(`${tag}:empty`);
      continue;
    }
    if (!body.startsWith('Добрый день!')) flags.push(`${tag}:greeting_missing`);
    const signed = body.endsWith(TEMPLATE_SIGN_OFF);
    if (!signed) flags.push(`${tag}:signature_mismatch`);
    const text = signed ? body.slice(0, -TEMPLATE_SIGN_OFF.length) : body;
    const plain = text.replace(ANY_PLACEHOLDER, ' ');
    words.set(tag, plain.trim().split(/\s+/).filter(Boolean).length);

    for (const found of new Set(text.match(ANY_PLACEHOLDER) ?? [])) {
      // Подпись — только в конце письма, её место проверено выше.
      if (!allowed.has(found) || found === P.signature) flags.push(`${tag}:placeholder_not_allowed(${found})`);
    }
    if (/[{}]/.test(plain)) flags.push(`${tag}:placeholder_broken`);
    for (const ph of [P.opening, P.case, P.hypothesis]) {
      if (countOf(text, ph) > 1) flags.push(`${tag}:placeholder_repeated(${ph})`);
    }
    for (const ph of [P.opening, P.hypothesis]) {
      if (text.includes(ph) && !ownParagraph(text, ph)) flags.push(`${tag}:placeholder_not_alone(${ph})`);
    }

    const questions = countOf(text, '?');
    if (questions === 0) flags.push(`${tag}:no_cta`);
    if (questions > 1) flags.push(`${tag}:more_than_one_cta`);
    if ((text.replace(/^Добрый день!/, '').match(/!/g) ?? []).length) flags.push(`${tag}:exclamation`);
    if (/\*\*|__|^#{1,6}\s/m.test(text)) flags.push(`${tag}:markdown`);
    textChecks(tag, text, chain, writerFree, examples, flags);
  }

  // Обязательные плейсхолдеры и их места: повод — в письме 1 (оба варианта)
  // и только там (в других письмах он повторял бы письмо 1), кейс — только в
  // письме 3 с кейсом, гипотеза — только в письме 3 без кейса.
  if (!t.bodyDirect.includes(P.opening)) flags.push(`L1:placeholder_missing(${P.opening})`);
  if (!t.bodyRouting.includes(P.opening)) flags.push(`L1r:placeholder_missing(${P.opening})`);
  if (chainUsesCase(chain) && !(t.bodyWithCase ?? '').includes(P.case)) flags.push(`L3c:placeholder_missing(${P.case})`);
  if (chainUsesHypothesis(chain) && !t.bodyWithoutCase.includes(P.hypothesis)) flags.push(`L3:placeholder_missing(${P.hypothesis})`);
  for (const [tag, raw] of bodies) {
    if (tag !== 'L1' && tag !== 'L1r' && raw.includes(P.opening)) flags.push(`${tag}:placeholder_misplaced(${P.opening})`);
    if (tag !== 'L3c' && allowed.has(P.case) && raw.includes(P.case)) flags.push(`${tag}:placeholder_misplaced(${P.case})`);
    if (tag !== 'L3' && allowed.has(P.hypothesis) && raw.includes(P.hypothesis)) flags.push(`${tag}:placeholder_misplaced(${P.hypothesis})`);
  }

  // Письмо 4 — самое короткое. Сравниваем с письмом 2 и письмом 3 без кейса:
  // в варианте с кейсом {{кейс}} — одно слово шаблона, а в письме это 20–40
  // слов кейса, и письмо 4 CEO «длиннее» его только на бумаге. Готовые письма
  // runQa сверяет честно, после подстановки.
  const last = words.get('L4');
  if (last !== undefined && ['L2', 'L3'].some((tag) => (words.get(tag) ?? Infinity) <= last)) flags.push('L4:not_shortest');

  return { status: flags.length ? 'failed' : 'passed', flags };
}

const TEMPLATE_PLACES: Record<string, string> = {
  L1: 'Письмо 1 (лично)',
  L1r: 'Письмо 1 («перешлите ответственному»)',
  L2: 'Письмо 2',
  L3c: 'Письмо 3 (с кейсом)',
  L3: 'Письмо 3 (без кейса)',
  L4: 'Письмо 4',
  subject: 'Тема письма 1',
};

const TEMPLATE_FLAG_TEXT: Record<string, string> = {
  empty: 'текст пустой',
  letters_missing: 'в ответе нет массива letters с письмами 1–4',
  greeting_missing: 'должно начинаться строкой «Добрый день!»',
  signature_mismatch: 'должно заканчиваться ровно «С уважением,» и с новой строки {{подпись}}',
  placeholder_not_allowed: 'плейсхолдер здесь не разрешён',
  placeholder_broken: 'сломанный плейсхолдер: одиночные фигурные скобки',
  placeholder_repeated: 'плейсхолдер стоит дважды',
  placeholder_not_alone: 'плейсхолдер должен быть отдельным абзацем, без другого текста',
  placeholder_missing: 'нет обязательного плейсхолдера',
  placeholder_misplaced: 'плейсхолдер не на своём месте',
  no_cta: 'нет вопроса — нужен ровно один «?»',
  more_than_one_cta: 'больше одного «?» — нужен ровно один',
  exclamation: 'восклицательный знак (можно только в «Добрый день!»)',
  'forbidden:urgency': 'давление срочностью (корень «срочн» нельзя даже с отрицанием)',
  'forbidden:unique': 'слово «уникальный»',
  'forbidden:guarantee': 'гарантии (корень «гарант» нельзя даже с отрицанием)',
  'forbidden:scarcity': 'давление дефицитом',
  'forbidden:superlative': 'превосходная степень о себе',
  'forbidden:emoji': 'эмодзи',
  internal_text: 'служебный текст (json, null, TODO)',
  internal_words: 'служебные слова (score, pipeline, ICP, LLM, evidence, скоринг)',
  markdown: 'разметка markdown',
  false_prior_contact: 'намёк на прошлый контакт («уже общались», «ранее обсуждали», «наш разговор») — только в оффере «Возврат»',
  unsupported_number: 'цифры не из утверждённых формулировок («2–3» — только перед словом «сегмент»)',
  fabrication: 'число словами или обещание срока или результата — подтвердить нечем',
  example_leak: 'в текст попал пример из задания — в шаблоне не может быть конкретной компании',
  not_shortest: 'письмо 4 должно быть короче письма 2 и письма 3 без кейса',
  subject_missing: 'нет темы',
  subject_placeholder: 'из плейсхолдеров в теме можно только «{{бренд}}»',
  subject_brand_unquoted: 'бренд в теме — только в ёлочках: «{{бренд}}»',
  subject_candidate_like: 'тема похожа на отклик на вакансию',
  subject_caps: 'слово капсом',
  subject_exclamation: 'восклицательный знак',
};

/**
 * Флаг проверки шаблона — по-русски: для повторного запроса писателю и для
 * пояснения в строке журнала («Письмо 2: цифры не из утверждённых формулировок
 * — 30%»). Незнакомый флаг — как есть.
 */
export function describeTemplateFlag(flag: string): string {
  const colon = flag.indexOf(':');
  const place = colon > 0 && TEMPLATE_PLACES[flag.slice(0, colon)] ? flag.slice(0, colon) : null;
  const rest = place ? flag.slice(colon + 1) : flag;
  const paren = /^(.*?)\((.*)\)$/.exec(rest);
  const kind = paren ? paren[1] : rest;
  const detail = paren ? paren[2] : null;
  const text = TEMPLATE_FLAG_TEXT[kind] ?? kind;
  return `${place ? `${TEMPLATE_PLACES[place]}: ` : ''}${text}${detail ? ` — ${detail}` : ''}`;
}

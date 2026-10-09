/**
 * S6 — цепочка английского аутрича v2: четыре письма CEO
 * (en-outreach-flow-improvements §5, 23.09.2026). Заменила цепочку
 * «SDR hiring-trigger» от 11.09.2026 (гарантия «3 SQL или бесплатно» ушла
 * вместе с ней — в новой цепочке её нет).
 *
 *  1 — повод → боль компании ({{pain}}) → что делает Polza → первые
 *      сегменты; вопрос «прислать список?» (общий ящик — «прислать тому, кто
 *      отвечает за продажи?»);
 *  2 — конкретная проблема, чем она обходится и что сделаем для компании;
 *  3 — доказательство: утверждённый кейс (только при совпадении отрасли),
 *      гипотеза из 2–3 сегментов, предложение бесплатной выборки 20–30 компаний;
 *  4 — закрыть переписку.
 *
 * 29.09.2026 — по структуре четырёх писем Ника (продажи): вместо строки «что
 * вы делаете» ({{about}}, «кринжик») — боль под повод, письма короче
 * (guardTemplate: письмо 1 ≤ 60 слов без плейсхолдеров, 2–4 ≤ 70). Спека
 * docs/superpowers/specs/2026-09-29-en-outreach-letters-pain-design.md.
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
 *
 * 30.09.2026 — разбор первой выгрузки по шаблону Ника: тема письма 1 — в
 * нескольких вариантах от повода и роли (letterSubject, {{subject}}), письмо
 * 2 начинается с напоминания о первом письме ({{followup}}) и говорит о
 * проблеме повода, а не об аутриче вообще; у компании без боли из разбора
 * сайта — запасная боль по поводу (fallbackPain), абзац больше не выпадает.
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
 * v2 (29.09.2026) — шаблоны с болью {{pain}} вместо строки о компании.
 * v3 (30.09.2026) — тема от повода и роли, письмо 2 с напоминанием о поводе.
 */
export const SEQUENCE_ID = 'en_offer_templates_v3';

export interface BuildLettersInput {
  company: string;
  trigger: Trigger | null;
  /** Боль компании из разбора сайта (siteProfile.painLine) — значение {{pain}}. */
  pain?: string | null;
  /** Письмо 1 для общего ящика: вопрос «прислать тому, кто отвечает за продажи?». */
  routing?: boolean;
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
      if (!title) {
        // Без короткого названия говорим про область найма — и она теперь не
        // всегда продажи: маркетинговая вакансия не должна превратиться в
        // «увидели, что вы нанимаете продажника».
        const marketing = /\b(marketing|demand gen|lead gen|cmo)\b/i.test(t.title ?? '');
        return marketing
          ? [`Saw that ${company} is hiring for demand generation.`, `Noticed ${company} is growing its marketing team.`]
          : [`Saw that ${company} is hiring for sales.`, `Noticed ${company} is growing its sales team.`];
      }
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

// Роль, которую можно назвать в теме и в боли: английское название продажной
// должности. «Stage», «Alternance», «Commercial», «Responsable Commercial»
// (французские вакансии) и стажёры давали «pipeline before your new Stage ramps».
// 09.10.2026: + маркетинг потока (demand gen, lead gen, growth marketing, head
// of marketing) — такие вакансии теперь тоже источник, и роль можно называть
// в теме: «pipeline before your new Demand Generation Manager ramps».
const SALES_ROLE_RE = /\b(?:sales|account executive|account manager|business development|sdr|bdr|ae|revenue|gtm|growth|partnerships?|marketing|demand gen(?:eration)?|lead gen(?:eration)?)\b/i;
const NOT_A_ROLE_RE = /\b(?:intern|internship|stage|stagiaire|alternance|trainee|werkstudent|praktik\w*)\b/i;

/** Роль для темы и коротких фраз: английская продажная должность не длиннее четырёх слов. */
function shortRole(t: Trigger | null): string | null {
  if (t?.type !== 'hiring') return null;
  const title = shortJobTitle(t.title);
  if (!title || title.split(' ').length > 4) return null;
  // Название продукта или юрлица внутри должности («Version2.ai Business Development Representative»).
  if (/[.\d@]/.test(title)) return null;
  return SALES_ROLE_RE.test(title) && !NOT_A_ROLE_RE.test(title) ? title : null;
}

/** «Knit's», но «Defense Unicorns'». */
function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

const SUBJECT_MAX = 80;

/**
 * Варианты темы письма 1 — «боль + компания, роль или повод», как у Ника
 * («pipeline before {role} ramps», «accounts for the new {role}», «target
 * accounts for {company}»). Раньше тему писал писатель шаблона — одну на
 * оффер, и 78 писем из 100 ушли бы с «outbound for {company}».
 */
export function subjectVariants(company: string, t: Trigger | null): string[] {
  switch (t?.type) {
    case 'hiring': {
      const role = shortRole(t);
      if (!role) {
        return [
          'pipeline before your new hire ramps',
          'first weeks of a new sales hire',
          `${company} sales hiring`,
          `target accounts for ${company}`,
        ];
      }
      return [
        `pipeline before your new ${role} ramps`,
        `accounts for the new ${role}`,
        `before your new ${role} starts`,
        `pipeline for ${possessive(company)} new ${role}`,
        `target accounts for ${company}`,
      ];
    }
    case 'yc':
      return [`target accounts for ${company}`, `outbound segments for ${company}`, 'first pipeline after YC', `first accounts for ${company} after YC`];
    case 'launch':
      return [`target accounts for the ${company} launch`, 'first accounts for the new launch', `outbound segments for ${company}`];
    case 'tech_stack':
      return [`target accounts for ${company}`, `outbound segments for ${company}`, `account list for ${company}`];
    default:
      return [`target accounts for ${company}`, `outbound segments for ${company}`, `new pipeline for ${company}`];
  }
}

/** Тема письма 1 — значение {{subject}}: вариант выбирается по компании; слишком длинные (длинное название) отпадают. */
export function letterSubject(company: string, t: Trigger | null): string {
  const variants = subjectVariants(company, t);
  const fit = variants.filter((s) => s.length <= SUBJECT_MAX);
  return pickVariant(company, fit.length ? fit : variants) ?? 'target accounts';
}

/**
 * Первая строка письма 2 — значение {{followup}}: напоминание о своём первом
 * письме с поводом компании («Following up on {company}'s {trigger}» у Ника).
 * Есть всегда: без повода — про outbound компании.
 */
export function followupPhrase(company: string, t: Trigger | null): string {
  switch (t?.type) {
    case 'hiring': {
      const title = shortJobTitle(t.title);
      return title ? `Following up on my note about the ${title} role at ${company}.` : `Following up on my note about sales hiring at ${company}.`;
    }
    case 'yc':
      return `Following up on my note about outbound at ${company} after YC.`;
    case 'launch':
      return `Following up on my note about the ${company} launch.`;
    default:
      return `Following up on my note about outbound at ${company}.`;
  }
}

/**
 * Запасная боль по поводу — когда разбор сайта боль не дал или она не прошла
 * проверку (painLineOf). Без неё абзац {{pain}} выпадал, и следующая фраза
 * письма («We take that off your plate…») ни к чему не относилась.
 */
export function fallbackPain(company: string, t: Trigger | null): string {
  const variants = ((): string[] => {
    switch (t?.type) {
      case 'hiring': {
        const who = shortRole(t) ?? 'sales hire';
        return [
          `When a new ${who} starts, the bottleneck is usually not the hire itself but having enough of the right accounts to work from the first week.`,
          `For a new ${who}, the bottleneck is usually not the pitch but knowing which accounts are worth the first calls.`,
        ];
      }
      case 'yc':
        return [
          'After YC, the bottleneck is usually not the product but getting enough first conversations with the right buyers.',
          'After YC, prospecting usually stays with the founders and competes with everything else for their time.',
        ];
      case 'launch':
        return ['After a launch, the bottleneck is usually not the product but getting it in front of new accounts while the news is fresh.'];
      case 'tech_stack':
        return ['With the tools already in place, the bottleneck is usually not sending but deciding which accounts to write to and why.'];
      default:
        return ['For most B2B teams, the bottleneck is usually not the offer but a steady flow of conversations with the right accounts.'];
    }
  })();
  return pickVariant(company, variants) ?? variants[0];
}

/** Проблема повода и чем она обходится — второй абзац письма 2 в образце писателю. */
function followupProblem(t: Trigger | null): string {
  switch (t?.type) {
    case 'hiring':
      return 'A common issue with a new sales hire: the first weeks go into building lists by hand. As a result, real conversations start late and the ramp drags.';
    case 'yc':
      return 'A common issue after YC: the founders do the prospecting themselves, in between everything else. As a result, outbound runs in bursts and the pipeline never gets steady.';
    case 'launch':
      return 'A common issue after a launch: the news reaches the existing audience and stops there. As a result, the window closes without new conversations.';
    case 'tech_stack':
      return 'A common issue with the tools already in place: one generic email goes to a broad list. As a result, the domain wears out and the team burns time on the wrong accounts.';
    default:
      return 'A common issue we see: one generic email goes to a broad list and nobody has a reason to reply. As a result, the domain wears out and the team burns time on the wrong accounts.';
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
 * плейсхолдерах). 29.09.2026 переписана по структуре Ника: повод и боль →
 * что делаем и с каких сегментов начали бы → вопрос «прислать список?»;
 * письмо 2 — напоминание о поводе, проблема этого повода, её цена и что
 * сделаем для компании; письмо 3 — пример и бесплатная
 * выборка; письмо 4 — закрыть переписку. Письма 2–4 — ответы в той же ветке:
 * своей темы у них нет.
 */
export function buildLetters(input: BuildLettersInput): PolzaOutreachLetter[] {
  const { company } = input;
  const phrase = triggerPhrase(company, input.trigger);

  const letter1 = signed(
    phrase,
    input.pain ?? fallbackPain(company, input.trigger),
    'That is the part we take on: the account list, the right contacts and the outbound sequence, with interested replies going straight to your team.',
    segmentsBlock(company, input.segments),
    input.routing
      ? `Should I send a first list of 20–30 target accounts to whoever handles sales at ${company}?`
      : 'Want me to send over a first list of 20–30 target accounts?',
  );

  const letter2 = signed(
    followupPhrase(company, input.trigger),
    followupProblem(input.trigger),
    `For ${company}, we could prepare three things: target accounts, the right contacts at each one, and a first sequence per segment.`,
    'Would you want to see what that account list could look like?',
  );

  const letter3 = signed(
    input.caseHit ? caseSentence(input.caseHit) : null,
    segmentsBlock(company, input.segments),
    `Before any call, I can put together a free sample of 20–30 target accounts for ${company}, so you can judge the quality first.`,
    'Want me to send it over?',
  );

  const letter4 = signed(
    `Last note from me. If new pipeline is on the agenda at ${company}, the account sample could still be useful. If not, I will close the thread here.`,
    'Should I leave it at that?',
  );

  const subject = letterSubject(company, input.trigger);
  return [
    { n: 1, subject, body: letter1 },
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
// forward», «look forward» так же пропустили бы прямое письмо. «Send them to
// whoever handles sales» — вопрос письма 1 по структуре Ника (29.09.2026).
const ROUTING_RE =
  /\b(?:right person|right people|right contact|who (?:owns|handles|leads|runs|looks after|is responsible|would be the right)|whoever (?:handles|runs|owns|leads)|point me to|forward (?:this|it|my (?:note|email|message))|pass (?:this|it) (?:on|along))\b/i;
/**
 * Длина письма шаблона в словах без плейсхолдеров и приветствия: письмо 1 —
 * до 60 (с болью ≤ 40 слов и сегментами выходит около 110–120), письма 2–4 —
 * до 70. Длинные письма не дочитывают (отзыв продаж 29.09.2026).
 */
const LETTER1_MAX_WORDS = 60;
const LETTER_MAX_WORDS = 70;

/** Слова текста письма: в счёт идёт то, где есть буква или цифра («—» и «-» — не слова). */
function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}
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
 * повод/боль/кейс/сегменты — отдельным абзацем без вводной строки, подпись —
 * последней строкой, у общего ящика — вопрос «кто у вас за это отвечает»,
 * напоминание {{followup}} — в письме 2 и только там, тема — {{subject}} (её
 * ставит код; своя тема — только у шаблонов до 30.09.2026),
 * длина писем без плейсхолдеров (too_long),
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

  // Тема: {{subject}} — её подставит код (letterSubject). Своя тема — у
  // шаблонов до 30.09.2026: из плейсхолдеров в ней только название компании.
  const subject = t.subject.trim();
  if (!subject) flags.push('subject_missing');
  else if (subject !== P.subject) {
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
    for (const ph of [P.trigger, P.pain, P.case, P.segments, P.followup]) {
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
    const words = wordCount(plain.replace(/^\s*Hi there,/, ' '));
    if (words > (tag.startsWith('L1') ? LETTER1_MAX_WORDS : LETTER_MAX_WORDS)) flags.push(`${tag}:too_long(${words})`);
  }

  // Обязательные плейсхолдеры и их места: повод и боль — в письме 1 (оба
  // варианта) и только там; кейс — только в письме 3 с кейсом; сегменты — в
  // письме 1 (обязательно, оба варианта) и в письме 3 (без кейса — обязательно).
  if (allowed.has(P.trigger)) {
    if (!t.bodyDirect.includes(P.trigger)) flags.push(`L1:placeholder_missing(${P.trigger})`);
    if (!t.bodyRouting.includes(P.trigger)) flags.push(`L1r:placeholder_missing(${P.trigger})`);
  }
  for (const ph of [P.pain, P.segments]) {
    if (!t.bodyDirect.includes(ph)) flags.push(`L1:placeholder_missing(${ph})`);
    if (!t.bodyRouting.includes(ph)) flags.push(`L1r:placeholder_missing(${ph})`);
  }
  if (!t.letter2.includes(P.followup)) flags.push(`L2:placeholder_missing(${P.followup})`);
  if (!t.bodyWithCase.includes(P.case)) flags.push(`L3c:placeholder_missing(${P.case})`);
  if (!t.bodyWithoutCase.includes(P.segments)) flags.push(`L3:placeholder_missing(${P.segments})`);
  for (const [tag, raw] of bodies) {
    if (allowed.has(P.trigger) && !tag.startsWith('L1') && raw.includes(P.trigger)) flags.push(`${tag}:placeholder_misplaced(${P.trigger})`);
    if (!tag.startsWith('L1') && raw.includes(P.pain)) flags.push(`${tag}:placeholder_misplaced(${P.pain})`);
    if (tag !== 'L3c' && raw.includes(P.case)) flags.push(`${tag}:placeholder_misplaced(${P.case})`);
    if (tag !== 'L2' && raw.includes(P.followup)) flags.push(`${tag}:placeholder_misplaced(${P.followup})`);
    if (!tag.startsWith('L1') && !tag.startsWith('L3') && raw.includes(P.segments)) flags.push(`${tag}:placeholder_misplaced(${P.segments})`);
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
    not_routing: 'the shared-inbox variant must ask who the right person is, offer to send the list to whoever handles sales, or ask to forward this email',
    too_long: `too long — email 1 must stay within ${LETTER1_MAX_WORDS} words and emails 2–4 within ${LETTER_MAX_WORDS}, not counting placeholders and the greeting; cut it down. Words now`,
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
    too_long: `слишком длинное (письмо 1 — до ${LETTER1_MAX_WORDS} слов, 2–4 — до ${LETTER_MAX_WORDS}, без плейсхолдеров); слов`,
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

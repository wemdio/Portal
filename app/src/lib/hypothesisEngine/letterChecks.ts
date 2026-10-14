/**
 * Детерминированный контроль писем «Движка вертикалей» (цепочки и шаблоны).
 *
 * Регламент писем живёт в промптах, но «жёсткие» правила без кода — это
 * самоконтроль модели. Здесь — проверки, которые машина делает надёжнее LLM:
 *  1. запрет тире («—», «–») в темах и телах;
 *  2. приветствие первой строкой тела;
 *  3. ровно один CTA-вопрос (один «?») в теле;
 *  4. стоп-фразы и рекламные клише регламента (для ru-цепочек);
 *  5. фактчек цифр: числа с «%», многозначные и десятичные в тексте письма
 *     обязаны встречаться в материалах задачи (evidence, кейс, бриф,
 *     winner-паттерны). Галлюцинированная статистика — худший вид слопа.
 *
 * Мелкие числа (<10 без %): пропускаем — «2 недели», «3–5 встреч» это
 * санкционированные регламентом конструкции, не рыночные факты.
 *
 * Английские правила ENG-кабинета действуют ТОЛЬКО у английских писем проекта
 * рынка 'us' (heUsEnglishLetters: язык 'en' И рынок 'us', рынок передаёт
 * стадия): тексты detail — по-английски (они уходят модели фикс-подсказкой
 * посреди английских писем), приветствие «Good evening» засчитывается, числа
 * читаются по-английски (запятая — разделитель тысяч), номер письма в detail
 * берётся из letterIndex, и только у них есть checkLetterParagraphs (абзацы,
 * только предупреждение). Язык 'en' — ещё не 'us': английскую цепочку
 * выбирает и сотрудник staff-инструмента у проекта рынка 'ru' (шаг 3), и её
 * письма, как и RU/PL, проверяются байт-в-байт как до переноса ENG
 * (решение владельца 14.10.2026 «Как было»). Рынок не передан — тоже как до
 * переноса.
 */

import type { HeMarket } from './market';

/**
 * Английские письма проекта рынка 'us' (ENG-кабинет) — единственный случай, где
 * письма проверяются и пишутся по правилам переноса ENG. Английская цепочка
 * проекта 'ru' (staff-инструмент) — нет: у неё всё как до переноса. Тот же
 * предикат читают стадии chain и template.
 */
export function heUsEnglishLetters(language: string | null | undefined, market: HeMarket | null | undefined): boolean {
  return language === 'en' && market === 'us';
}

export interface HeLetterRuleViolation {
  /** Номер письма (1-based), вариант в detail ('A'/'B'). */
  letter: number;
  /** 'paragraphs' даёт только checkLetterParagraphs (предупреждение), не checkLetterRules. */
  rule: 'dash' | 'greeting' | 'cta' | 'stop_phrase' | 'unverified_number' | 'tell' | 'paragraphs';
  detail: string;
}

/**
 * EN «tells» — частотные маркеры LLM-стиля в аутрич-письмах (см. обсуждение
 * 2026-08-07: запреты в промпте снижают, но не устраняют их; устраняет
 * детерминированная проверка + перепись). Детали на английском — этот текст
 * уходит обратно в LLM на перепись.
 */
const TELLS_EN: Array<{ re: RegExp; label: string }> = [
  { re: /\b(really|truly|actually|genuinely|literally)\b/i, label: 'filler intensifier' },
  { re: /\bi hope (this (email|message|note) finds you well|you(?:'re| are) (?:doing )?well)\b/i, label: 'throat-clearing opener' },
  { re: /\bnot only\b[^.!?;]{0,80}\bbut also\b/i, label: 'not-only/but-also construction' },
  { re: /\b(leverage|underscore|delve(?:\s+into)?|landscape|synergy|synergies|empower|elevate|supercharge|game[- ]changer|cutting[- ]edge|seamless|streamline|unlock)\b/i, label: 'corporate-register word' },
  { re: /\bjust (wanted to|checking in|following up|reaching out)\b/i, label: 'hedging filler' },
];

const GREETING_RE = /^(здравствуйте|здравствуй|добрый\s+день|доброе\s+утро|добрый\s+вечер|доброго\s+(дня|времени)|привет|hi\b|hello\b|hey\b|dear\b|good\s+(morning|afternoon|day)|dzień\s+dobry|cześć|witam)/i;

/**
 * «Good evening» — обычное английское приветствие, но GREETING_RE его не знает,
 * и EN-письмо с ним получало нарушение и платный фикс-проход. Засчитываем
 * только у английских писем проекта 'us' (heUsEnglishLetters): GREETING_RE
 * проверяет и RU/PL-письма, и английские письма проекта 'ru', их результат не
 * меняем.
 */
const GREETING_EN_EXTRA_RE = /^good\s+evening\b/i;

/** Стоп-фразы регламента (RU): точные формулировки + рекламные клише. */
const STOP_PHRASES_RU = [
  'обсудить исходящие',
  'к вам или в коммерческий',
  'спрос неровный',
  'у многих',
  'поток заявок',
  'команда профессионалов',
  'индивидуальный подход',
  'гарантируем',
  'бесплатно',
  'выгодн',
];

// \b в JS не работает с кириллицей — границы задаём lookaround'ами.
const CYR = 'А-Яа-яЁёA-Za-z0-9_';
const CLICHE_WORDS_RU = [
  new RegExp(`(^|[^${CYR}])лидер(ом|ы|а)?($|[^${CYR}])`, 'i'),
  new RegExp(`(^|[^${CYR}])лучши[йх]($|[^${CYR}])`, 'i'),
  new RegExp(`(^|[^${CYR}])эффективн(ый|ого|ым|ые|ая|ой|ую)?($|[^${CYR}])`, 'i'),
];

/** Числа для фактчека: с «%», многозначные (≥10), десятичные с запятой/точкой. */
const NUMBER_RE = /\d[\d\s]*(?:[.,]\d+)?\s*%|\d{2,}(?:[.,]\d+)?|\d+[.,]\d+/g;

function normalizeNumberToken(raw: string): string {
  return raw.replace(/[\s%]/g, '').replace(',', '.').replace(/\.0+$/, '');
}

/**
 * Английское чтение чисел (английские письма проекта 'us'): запятая — разделитель тысяч, точка —
 * десятичная. «10,000» → 10000, «$35,000» → 35000, «1,234,567» — одно число,
 * «3.5%» → 3.5. Русское чтение (NUMBER_RE) делает из «10,000» десятичное
 * «10.000» → «10», а «1,234,567» рвёт на «1,234» и «567», поэтому любое
 * американское число сверялось не с тем. Пробел числа не склеивает (в
 * английском тексте «in 2023 40%» — два числа). Отбор тот же: с «%»,
 * многозначные, десятичные.
 */
const NUMBER_RE_EN = /\d{1,3}(?:,\d{3})+(?:\.\d+)?(?:\s*%)?|\d+(?:\.\d+)?\s*%|\d{2,}(?:\.\d+)?|\d+\.\d+/g;

function normalizeNumberTokenEn(raw: string): string {
  return raw.replace(/[\s%,]/g, '').replace(/\.0+$/, '');
}

/**
 * Числа в русской записи внутри корпуса EN-цепочки: материалы стаффа бывают
 * русскими (гипотезы, доказательства), а английское письмо пишет то же число
 * по-английски («1,7 раза» → «1.7x», «10 000» → «10,000»). Берём только
 * однозначную русскую запись: тысячи через пробел и десятичную запятую, после
 * которой не ровно три цифры («3,5», «12,75»). «10,000» сюда не попадает:
 * иначе корпус снова дал бы ложное «10». Только для фактов, не для письма.
 */
const RU_FORMAT_IN_EN_CORPUS_RE = /\d{1,3}(?:[ \u00a0]\d{3})+(?:,\d+)?|\d+,(?:\d{1,2}|\d{4,})(?!\d)/g;

function normalizeRuFormatToken(raw: string): string {
  return raw.replace(/\s/g, '').replace(',', '.').replace(/\.0+$/, '');
}

/**
 * Множества фактов, прочитанных по-английски. Письмо обязано читаться так же,
 * как корпус: «10,000» письма по-английски — 10000, а в корпусе, прочитанном
 * по-русски, лежит «10», и верное число флагалось бы как выдуманное.
 * findUnverifiedNumbers по умолчанию берёт чтение отсюда.
 */
const EN_NUMBER_FACTS = new WeakSet<Set<string>>();

/**
 * Множество нормализованных чисел из корпуса материалов. Английские письма
 * проекта 'us' (heUsEnglishLetters(language, market)) — английское чтение
 * (плюс однозначная русская запись, см. выше); любой другой язык, английский
 * у проекта 'ru' или рынок не передан — прежнее чтение байт-в-байт.
 */
export function extractNumberFacts(corpus: string, language?: string, market?: HeMarket): Set<string> {
  // Шум, который иначе покрывает фактчек ложно-положительно: uuid кейсов/
  // проектов (цифровые группы) и ISO-даты/таймстампы (дни/минуты/секунды
  // дают почти все двузначные числа).
  const clean = corpus
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, ' ')
    .replace(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?(?:[+-]\d{2}:?\d{2})?)?/g, ' ');
  const out = new Set<string>();
  if (heUsEnglishLetters(language, market)) {
    // Целую часть дробного числа EN отдельно НЕ добавляет (русское чтение ниже
    // добавляет): «94.5%» не покрывает «94%», а EN-промпт велит цитировать
    // числа клиента дословно и не округлять их. Целое покрывают только дроби с
    // нулевой дробной частью: «2.0», «2.0x», «40.0%» нормализация и так сводит
    // к «2» и «40» (normalizeNumberTokenEn и normalizeRuFormatToken срезают «.0»).
    const add = (norm: string) => {
      if (norm) out.add(norm);
    };
    // Русскую запись с десятичной запятой («11,8%», «12,75», «10 000,5»)
    // английское чтение разорвало бы на «11» и «8%» — округление и выдуманное
    // число, и письмо с ними прошло бы сверку. Её читает только русское чтение
    // (вторая строка); тысячи через пробел без запятой («10 000», телефон
    // подписи «555 123 4567») по-прежнему достаются обоим чтениям.
    const enText = clean.replace(RU_FORMAT_IN_EN_CORPUS_RE, (m) => (m.includes(',') ? ' ' : m));
    for (const m of enText.matchAll(NUMBER_RE_EN)) add(normalizeNumberTokenEn(m[0]));
    for (const m of clean.matchAll(RU_FORMAT_IN_EN_CORPUS_RE)) add(normalizeRuFormatToken(m[0]));
    EN_NUMBER_FACTS.add(out);
    return out;
  }
  for (const m of clean.matchAll(NUMBER_RE)) {
    const norm = normalizeNumberToken(m[0]);
    if (norm) out.add(norm);
    // «11,8%» покрывает и целое «12» не должно — но «в 2 раза» из «2,0» должно.
    const int = norm.replace(/\.\d+$/, '');
    if (int) out.add(int);
  }
  return out;
}

/**
 * Числа из текста письма, которых нет в корпусном множестве. language (с
 * market) — как читать числа письма: по-английски только английские письма
 * проекта 'us'. Не передан → так же, как прочитан корпус (facts из
 * extractNumberFacts(corpus, 'en', 'us') — по-английски, иначе по-русски).
 * Передавать его нужно только для множества, собранного вручную: расхождение
 * с чтением корпуса ломает сверку в обе стороны.
 */
export function findUnverifiedNumbers(
  text: string,
  facts: Set<string>,
  language?: string,
  market?: HeMarket,
): string[] {
  const en = language !== undefined ? heUsEnglishLetters(language, market) : EN_NUMBER_FACTS.has(facts);
  const re = en ? NUMBER_RE_EN : NUMBER_RE;
  const normalize = en ? normalizeNumberTokenEn : normalizeNumberToken;
  const bad = new Set<string>();
  for (const m of text.matchAll(re)) {
    const norm = normalize(m[0]);
    if (!norm) continue;
    if (!facts.has(norm)) bad.add(m[0].trim());
  }
  return [...bad];
}

export interface HeLetterForCheck {
  subject: string | null;
  body: string;
  /** Вариант ('A' основной, 'B') — попадает в detail нарушения. */
  variant?: string;
  /**
   * Номер письма в цепочке (1-based). Учитывается только у английских писем
   * проекта 'us' (heUsEnglishLetters): стадии сдают варианты A и B одним
   * плоским списком, и позиция в списке — не номер письма (B письма 1 получал
   * тег «2B», A письма 2 — «3A»), так что фикс-подсказка отправляла модель не
   * к тому письму. RU/PL и английские письма проекта 'ru' по-прежнему берут
   * позицию в списке.
   */
  letterIndex?: number;
}

/** Номер письма для нарушения: letterIndex — только у английских писем 'us', иначе позиция в списке. */
function letterNumber(letter: HeLetterForCheck, position: number, en: boolean): number {
  const n = letter.letterIndex;
  return en && typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : position + 1;
}

/**
 * Проверить письма по детерминированным правилам. `facts` — числа корпуса
 * материалов (extractNumberFacts); пустое множество = фактчек пропускаем
 * (нет материалов — не к чему привязываться). Числа письма читаются так же,
 * как прочитан корпус (см. findUnverifiedNumbers), а не по `language`: стадия,
 * собравшая facts без языка, сверяет по-старому.
 * `market` — рынок проекта: английские тексты detail, «Good evening» и
 * letterIndex — только при heUsEnglishLetters(language, market). Проверка
 * LLM-tells (TELLS_EN) была у любых английских писем и до переноса ENG —
 * она по-прежнему идёт по языку.
 */
export function checkLetterRules(
  letters: HeLetterForCheck[],
  language: string,
  facts: Set<string>,
  market?: HeMarket,
): HeLetterRuleViolation[] {
  const violations: HeLetterRuleViolation[] = [];
  const en = heUsEnglishLetters(language, market);
  letters.forEach((letter, i) => {
    const n = letterNumber(letter, i, en);
    const tag = letter.variant ? `${n}${letter.variant}` : `${n}`;
    const subject = letter.subject ?? '';
    if (subject.includes('—') || subject.includes('–') || letter.body.includes('—') || letter.body.includes('–')) {
      violations.push({
        letter: n,
        rule: 'dash',
        detail: en
          ? `letter ${tag}: em and en dashes ("—", "–") are banned; replace each one with a comma, colon or period`
          : `письмо ${tag}: тире («—»/«–») запрещено — замени запятой, двоеточием или точкой`,
      });
    }
    const firstLine = letter.body.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
    if (!GREETING_RE.test(firstLine) && !(en && GREETING_EN_EXTRA_RE.test(firstLine))) {
      violations.push({
        letter: n,
        rule: 'greeting',
        detail: en
          ? `letter ${tag}: the first line of the body must be a greeting that reads right without a name ("Hello,", "Hi there,", "Good afternoon,")`
          : `письмо ${tag}: первая строка тела должна быть приветствием («Здравствуйте, …», «Добрый день»)`,
      });
    }
    const questions = (letter.body.match(/\?/g) ?? []).length;
    if (questions !== 1) {
      violations.push({
        letter: n,
        rule: 'cta',
        detail: en
          ? `letter ${tag}: the body needs exactly one CTA question (one "?"); it has ${questions}`
          : `письмо ${tag}: в теле ровно один CTA-вопрос (один «?»), сейчас ${questions}`,
      });
    }
    if (language === 'ru') {
      const lower = letter.body.toLowerCase();
      for (const phrase of STOP_PHRASES_RU) {
        if (lower.includes(phrase)) {
          violations.push({ letter: n, rule: 'stop_phrase', detail: `письмо ${tag}: стоп-фраза регламента «${phrase}»` });
        }
      }
      for (const re of CLICHE_WORDS_RU) {
        const m = letter.body.match(re);
        if (m) {
          violations.push({ letter: n, rule: 'stop_phrase', detail: `письмо ${tag}: рекламное клише «${m[0]}»` });
        }
      }
    }
    if (language === 'en') {
      for (const tell of TELLS_EN) {
        const m = letter.body.match(tell.re);
        if (m) {
          violations.push({ letter: n, rule: 'tell', detail: `letter ${tag}: LLM tell "${m[0]}" (${tell.label}) — rewrite that part plainly` });
        }
      }
    }
    if (facts.size > 0) {
      for (const token of findUnverifiedNumbers(`${subject}\n${letter.body}`, facts)) {
        violations.push({
          letter: n,
          rule: 'unverified_number',
          detail: en
            ? `letter ${tag}: the number "${token}" is not in the materials; remove it or replace it with a figure from the materials`
            : `письмо ${tag}: число «${token}» отсутствует в материалах — удали или замени фактом из материалов`,
        });
      }
    }
  });
  return violations;
}

/* ───────────── Абзацы EN-письма: только предупреждение ───────────── */

/** Абзацы тела: блоки, разделённые пустой строкой (строка из одних пробелов — тоже пустая). */
function splitParagraphs(body: string): string[] {
  return body
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n(?:[^\S\n]*\n)+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Делит ли вопрос абзац с другим текстом: до вопросительного предложения
 * кончается другое предложение («…segment. Is this relevant?») или после «?»
 * идёт ещё текст («Is this relevant? Thanks either way.»). Конец предложения —
 * «.»/«!» и пробел перед заглавной буквой, кавычкой или {{оператором}}, чтобы
 * «U.S. teams» и «e.g. retail» внутри самого вопроса не считались границей.
 */
function questionSharesParagraph(paragraph: string): boolean {
  const head = paragraph.slice(0, paragraph.indexOf('?'));
  const tail = paragraph.slice(paragraph.lastIndexOf('?') + 1);
  return /[.!]["')\]]*\s+["'(]?[A-Z{]/.test(head) || /[A-Za-z0-9{]/.test(tail);
}

/**
 * Предикат абзацев EN-письма (ослабленный перенос из V2): минимум 4 абзаца
 * через пустую строку (приветствие / суть / вопрос / подпись), вопрос —
 * отдельным абзацем и не последним. Одиночные переводы строки до вопроса НЕ
 * запрещены (приветствие в две строки нормально). Письмо без «?» здесь не
 * флагуется по вопросу — это нарушение 'cta' в checkLetterRules.
 * null — абзацы в порядке.
 */
function paragraphProblem(body: string): string | null {
  const paragraphs = splitParagraphs(body);
  if (paragraphs.length < 4) {
    return `split the body into at least 4 paragraphs with a blank line between them (greeting, message, question, signature); it has ${paragraphs.length}`;
  }
  const q = paragraphs.findIndex((p) => p.includes('?'));
  if (q === -1) return null;
  if (q === paragraphs.length - 1) {
    return 'the question is the last paragraph; the signature goes after it, separated by a blank line';
  }
  if (q === 0) {
    return 'the question is in the first paragraph; the greeting and the message come before it, each followed by a blank line';
  }
  if (questionSharesParagraph(paragraphs[q])) {
    return 'the question shares a paragraph with other text; give it its own paragraph, with a blank line before and after it';
  }
  return null;
}

/**
 * Абзацы писем: только у английских писем проекта 'us' (heUsEnglishLetters),
 * только варианты A/B (сегментные варианты — фрагменты тела, их не
 * проверяем). Это ПРЕДУПРЕЖДЕНИЕ: в checkLetterRules не входит, фикс-проход
 * не запускает и ничего не блокирует. Стадия chain пишет его в лог; стадия
 * template (английские письма 'us') кладёт его в rule_violations финальных
 * писем (personalization_plan), но рерайт критика по нему не откатывает. Для
 * других языков и для английских писем проекта 'ru' — пустой список.
 */
export function checkLetterParagraphs(
  letters: HeLetterForCheck[],
  language: string,
  market?: HeMarket,
): HeLetterRuleViolation[] {
  if (!heUsEnglishLetters(language, market)) return [];
  const out: HeLetterRuleViolation[] = [];
  letters.forEach((letter, i) => {
    const problem = paragraphProblem(letter.body);
    if (!problem) return;
    const n = letterNumber(letter, i, true);
    const tag = letter.variant ? `${n}${letter.variant}` : `${n}`;
    out.push({ letter: n, rule: 'paragraphs', detail: `letter ${tag}: ${problem}` });
  });
  return out;
}

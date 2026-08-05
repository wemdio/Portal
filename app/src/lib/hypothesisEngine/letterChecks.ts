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
 */

export interface HeLetterRuleViolation {
  /** Номер письма (1-based), вариант в detail ('A'/'B'). */
  letter: number;
  rule: 'dash' | 'greeting' | 'cta' | 'stop_phrase' | 'unverified_number';
  detail: string;
}

const GREETING_RE = /^(здравствуйте|добрый\s+день|доброе\s+утро|добрый\s+вечер|привет|hi\b|hello\b|dear\b|good\s+(morning|afternoon)|dzień\s+dobry|cześć)/i;

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

const CLICHE_WORDS_RU = [/\bлидер(ом|ы|а)?\b/i, /\bлучши[йх]?\b/i, /\bэффективн(ый|ого|ым|ые)?\b/i];

/** Числа для фактчека: с «%», многозначные (≥10), десятичные с запятой/точкой. */
const NUMBER_RE = /\d[\d\s]*(?:[.,]\d+)?\s*%|\d{2,}(?:[.,]\d+)?|\d+[.,]\d+/g;

function normalizeNumberToken(raw: string): string {
  return raw.replace(/[\s%]/g, '').replace(',', '.').replace(/\.0+$/, '');
}

/** Множество нормализованных чисел из корпуса материалов. */
export function extractNumberFacts(corpus: string): Set<string> {
  const out = new Set<string>();
  for (const m of corpus.matchAll(NUMBER_RE)) {
    const norm = normalizeNumberToken(m[0]);
    if (norm) out.add(norm);
    // «11,8%» покрывает и целое «12» не должно — но «в 2 раза» из «2,0» должно.
    const int = norm.replace(/\.\d+$/, '');
    if (int) out.add(int);
  }
  return out;
}

/** Числа из текста письма, которых нет в корпусном множестве. */
export function findUnverifiedNumbers(text: string, facts: Set<string>): string[] {
  const bad = new Set<string>();
  for (const m of text.matchAll(NUMBER_RE)) {
    const norm = normalizeNumberToken(m[0]);
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
}

/**
 * Проверить письма по детерминированным правилам. `facts` — числа корпуса
 * материалов (extractNumberFacts); пустое множество = фактчек пропускаем
 * (нет материалов — не к чему привязываться).
 */
export function checkLetterRules(
  letters: HeLetterForCheck[],
  language: string,
  facts: Set<string>,
): HeLetterRuleViolation[] {
  const violations: HeLetterRuleViolation[] = [];
  letters.forEach((letter, i) => {
    const tag = letter.variant ? `${i + 1}${letter.variant}` : `${i + 1}`;
    const subject = letter.subject ?? '';
    if (subject.includes('—') || subject.includes('–') || letter.body.includes('—') || letter.body.includes('–')) {
      violations.push({ letter: i + 1, rule: 'dash', detail: `письмо ${tag}: тире («—»/«–») запрещено — замени запятой, двоеточием или точкой` });
    }
    const firstLine = letter.body.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
    if (!GREETING_RE.test(firstLine)) {
      violations.push({ letter: i + 1, rule: 'greeting', detail: `письмо ${tag}: первая строка тела должна быть приветствием («Здравствуйте, …», «Добрый день»)` });
    }
    const questions = (letter.body.match(/\?/g) ?? []).length;
    if (questions !== 1) {
      violations.push({ letter: i + 1, rule: 'cta', detail: `письмо ${tag}: в теле ровно один CTA-вопрос (один «?»), сейчас ${questions}` });
    }
    if (language === 'ru') {
      const lower = letter.body.toLowerCase();
      for (const phrase of STOP_PHRASES_RU) {
        if (lower.includes(phrase)) {
          violations.push({ letter: i + 1, rule: 'stop_phrase', detail: `письмо ${tag}: стоп-фраза регламента «${phrase}»` });
        }
      }
      for (const re of CLICHE_WORDS_RU) {
        const m = letter.body.match(re);
        if (m) {
          violations.push({ letter: i + 1, rule: 'stop_phrase', detail: `письмо ${tag}: рекламное клише «${m[0]}»` });
        }
      }
    }
    if (facts.size > 0) {
      for (const token of findUnverifiedNumbers(`${subject}\n${letter.body}`, facts)) {
        violations.push({ letter: i + 1, rule: 'unverified_number', detail: `письмо ${tag}: число «${token}» отсутствует в материалах — удали или замени фактом из материалов` });
      }
    }
  });
  return violations;
}

/**
 * Founded-year extractor — extracts the company founding year from page HTML.
 *
 * Strategy (ordered from most reliable to most heuristic):
 *   1. JSON-LD `foundingDate` from schema.org Organization markup.
 *   2. Microdata: `itemprop="foundingDate"` content / value.
 *   3. Phrase patterns ("founded in YYYY", "основана в YYYY", "с YYYY года",
 *      "год основания: YYYY", ...).
 *   4. Footer copyright ranges (© 2010—2025 → 2010) — strong signal.
 *   5. "N лет на рынке" / "более N лет работаем" → currentYear - N as a
 *      derived founding year. Used last because it's an approximation.
 *   6. Single-year copyright (© 2018) as a weak fallback only when older
 *      than the current year (a current-year © tells us nothing).
 */

const JSON_LD_FOUNDING_RE = /"foundingDate"\s*:\s*"(\d{4})/;

// Microdata schema.org Organization foundingDate — `<meta itemprop="foundingDate" content="2010">`
// or `<time itemprop="foundingDate" datetime="2010-01-01">`.
const MICRODATA_FOUNDING_RE =
  /itemprop\s*=\s*["']foundingDate["'][^>]*?(?:content|datetime|value)\s*=\s*["'](\d{4})/i;

const PHRASE_PATTERNS: RegExp[] = [
  // English
  /\bfounded\s+(?:in\s+)?(\d{4})\b/i,
  /\bestablished\s+(?:in\s+)?(\d{4})\b/i,
  /\bsince\s+(\d{4})\b/i,
  /\best\.\s*(\d{4})\b/i,
  /\byear\s+founded\s*[:—\-–]?\s*(\d{4})/i,
  /\bin\s+business\s+since\s+(\d{4})\b/i,
  // Russian
  /основан[аоы]?\s+в\s+(\d{4})/i,
  /компания\s+основана\s+в\s+(\d{4})/i,
  /на\s+рынке\s+с\s+(\d{4})/i,
  /работа(?:ем|ет)\s+с\s+(\d{4})/i,
  /с\s+(\d{4})\s+года/i,
  /создан[аоы]?\s+в\s+(\d{4})/i,
  /начал[аои]?\s+(?:работу|деятельность)\s+в\s+(\d{4})/i,
  /существуем\s+с\s+(\d{4})/i,
  /год\s+основания\s*[:—\-–]?\s*(\d{4})/i,
  /дата\s+основания\s*[:—\-–]?\s*(?:\d{1,2}[.\-/]\d{1,2}[.\-/])?(\d{4})/i,
  // "Открыты с YYYY", "Производим с YYYY"
  /(?:открыт[аыо]?|производим|занимаемся|оказываем\s+услуги)\s+с\s+(\d{4})/i,
];

// "N лет на рынке" / "более N лет работаем" — derive founding year from
// the duration. Captures N as group 1; the year is derived as currentYear-N.
const DURATION_PATTERNS: RegExp[] = [
  /(?:более|свыше|уже)\s+(\d{1,2})\s+лет\s+(?:на\s+рынке|в\s+бизнесе|работаем|опыт[а]?)/i,
  /(\d{1,2})\s+лет\s+(?:на\s+рынке|в\s+(?:бизнесе|сфере|отрасли))/i,
  /опыт\s+работы\s+(?:более\s+)?(\d{1,2})\+?\s+лет/i,
  /\b(\d{1,2})\+?\s+years?\s+(?:in\s+business|on\s+the\s+market|of\s+experience)/i,
];

const COPYRIGHT_RANGE_RE = /©\s*(\d{4})\s*[—\-–]\s*\d{4}/;
const COPYRIGHT_SINGLE_RE = /©\s*(\d{4})\b/;

const MIN_YEAR = 1900; // generous floor — some legit B2B firms predate this
const MIN_PLAUSIBLE_YEAR = 1990; // used for derived/weak signals

function isPlausibleYear(year: number, floor = MIN_YEAR): boolean {
  const max = new Date().getFullYear() + 1;
  return year >= floor && year <= max;
}

export function extractFoundedYear(html: string): number | undefined {
  if (!html) return undefined;

  // 1. JSON-LD structured data — most reliable.
  const jm = html.match(JSON_LD_FOUNDING_RE);
  if (jm) {
    const year = parseInt(jm[1], 10);
    if (isPlausibleYear(year)) return year;
  }

  // 2. Microdata itemprop="foundingDate".
  const md = html.match(MICRODATA_FOUNDING_RE);
  if (md) {
    const year = parseInt(md[1], 10);
    if (isPlausibleYear(year)) return year;
  }

  // 3. Explicit phrase patterns.
  for (const pattern of PHRASE_PATTERNS) {
    const m = html.match(pattern);
    if (m) {
      const year = parseInt(m[1], 10);
      if (isPlausibleYear(year)) return year;
    }
  }

  // 4. Copyright range (© YYYY—YYYY) — the lower bound is usually the
  //    founding year (or close to it).
  const cm = html.match(COPYRIGHT_RANGE_RE);
  if (cm) {
    const year = parseInt(cm[1], 10);
    if (isPlausibleYear(year, MIN_PLAUSIBLE_YEAR)) return year;
  }

  // 5. Duration derivations ("N лет на рынке" → currentYear - N).
  //    Only trust durations of 1-50 years (older claims rarely on the page).
  for (const pattern of DURATION_PATTERNS) {
    const m = html.match(pattern);
    if (m) {
      const years = parseInt(m[1], 10);
      if (years >= 1 && years <= 50) {
        const derived = new Date().getFullYear() - years;
        if (isPlausibleYear(derived, MIN_PLAUSIBLE_YEAR)) return derived;
      }
    }
  }

  // 6. Weak fallback: single-year copyright older than current year.
  //    Current-year © tells us nothing about founding.
  const cs = html.match(COPYRIGHT_SINGLE_RE);
  if (cs) {
    const year = parseInt(cs[1], 10);
    if (isPlausibleYear(year, MIN_PLAUSIBLE_YEAR) && year < new Date().getFullYear()) return year;
  }

  return undefined;
}

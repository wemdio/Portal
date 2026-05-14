const JSON_LD_FOUNDING_RE = /"foundingDate"\s*:\s*"(\d{4})/;

const PHRASE_PATTERNS: RegExp[] = [
  /\bfounded\s+in\s+(\d{4})\b/i,
  /\bestablished\s+(?:in\s+)?(\d{4})\b/i,
  /\bsince\s+(\d{4})\b/i,
  /\best\.\s*(\d{4})\b/i,
  /основан[аоы]?\s+в\s+(\d{4})/i,
  /на\s+рынке\s+с\s+(\d{4})/i,
  /работаем\s+с\s+(\d{4})/i,
  /с\s+(\d{4})\s+года/i,
  /создан[аоы]?\s+в\s+(\d{4})/i,
  /начал[аои]?\s+(?:работу|деятельность)\s+в\s+(\d{4})/i,
  /существуем\s+с\s+(\d{4})/i,
  /компании\s+(?:уже\s+)?(?:более\s+)?\s*\d+\s+лет/i,
  /год\s+основания\s*[:—\-–]\s*(\d{4})/i,
];

const COPYRIGHT_RANGE_RE = /©\s*(\d{4})\s*[—\-–]\s*\d{4}/;
const COPYRIGHT_SINGLE_RE = /©\s*(\d{4})\b/;

const MIN_YEAR = 1990;

function isPlausibleYear(year: number): boolean {
  const max = new Date().getFullYear() + 1;
  return year >= MIN_YEAR && year <= max;
}

export function extractFoundedYear(html: string): number | undefined {
  if (!html) return undefined;

  // Try JSON-LD structured data first — most reliable source.
  const jm = html.match(JSON_LD_FOUNDING_RE);
  if (jm) {
    const year = parseInt(jm[1], 10);
    if (isPlausibleYear(year)) return year;
  }

  for (const pattern of PHRASE_PATTERNS) {
    const m = html.match(pattern);
    if (m) {
      const year = parseInt(m[1], 10);
      if (isPlausibleYear(year)) return year;
    }
  }

  const cm = html.match(COPYRIGHT_RANGE_RE);
  if (cm) {
    const year = parseInt(cm[1], 10);
    if (isPlausibleYear(year)) return year;
  }

  const cs = html.match(COPYRIGHT_SINGLE_RE);
  if (cs) {
    const year = parseInt(cs[1], 10);
    if (isPlausibleYear(year) && year < new Date().getFullYear()) return year;
  }

  return undefined;
}

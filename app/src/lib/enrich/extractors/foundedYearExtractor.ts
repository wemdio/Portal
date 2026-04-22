const PHRASE_PATTERNS: RegExp[] = [
  /\bfounded\s+in\s+(\d{4})\b/i,
  /\bestablished\s+(?:in\s+)?(\d{4})\b/i,
  /\bsince\s+(\d{4})\b/i,
  /основан[аоы]?\s+в\s+(\d{4})/i,
  /на\s+рынке\s+с\s+(\d{4})/i,
  /работаем\s+с\s+(\d{4})/i,
  /с\s+(\d{4})\s+года/i,
];

const COPYRIGHT_RANGE_RE = /©\s*(\d{4})\s*[—\-–]\s*\d{4}/;

const MIN_YEAR = 1990;

function isPlausibleYear(year: number): boolean {
  const max = new Date().getFullYear() + 1;
  return year >= MIN_YEAR && year <= max;
}

export function extractFoundedYear(html: string): number | undefined {
  if (!html) return undefined;

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

  return undefined;
}

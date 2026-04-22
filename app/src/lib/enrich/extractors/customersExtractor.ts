import * as cheerio from 'cheerio';

const JUNK_PATTERNS: RegExp[] = [
  /logo/i,
  /image/i,
  /icon/i,
  /photo/i,
  /avatar/i,
  /^\s*\d+\s*$/,
];

function isJunk(s: string): boolean {
  if (!s || s.length > 60) return true;
  return JUNK_PATTERNS.some((re) => re.test(s));
}

const CASE_PREFIX = /^(?:кейс|case|case study|клиент)\s*[:—\-–]\s*(.+)$/i;

function cleanCaseTitle(title: string): string {
  const m = title.match(CASE_PREFIX);
  if (m && m[1].trim()) return m[1].trim();
  return title.trim();
}

const LOGO_CONTAINER_SELECTOR =
  '[class*="client"] img[alt], [class*="customer"] img[alt], [class*="-logos"] img[alt]';

const CASE_CARD_SELECTOR = '[class*="case-card"], [class*="client-card"]';

export function extractCustomers(html: string): string[] {
  if (!html) return [];
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const result: string[] = [];
  const cap = 30;

  $(LOGO_CONTAINER_SELECTOR).each((_, el) => {
    if (result.length >= cap) return false;
    const alt = ($(el).attr('alt') ?? '').trim();
    if (isJunk(alt)) return;
    const key = alt.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(alt);
  });

  if (result.length < cap) {
    $(CASE_CARD_SELECTOR).each((_, container) => {
      if (result.length >= cap) return false;
      const heading = $(container).find('h2, h3').first().text().trim();
      if (!heading) return;
      const cleaned = cleanCaseTitle(heading);
      if (isJunk(cleaned)) return;
      const key = cleaned.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      result.push(cleaned);
    });
  }

  return result.slice(0, cap);
}

import * as cheerio from 'cheerio';

const JUNK_PATTERNS: RegExp[] = [
  /^logo$/i, /^image$/i, /^icon$/i, /^photo$/i, /^avatar$/i,
  /^\s*\d+\s*$/, /^img$/i, /^picture$/i, /^banner$/i,
  /^logo\s*\d*$/i, /^client\s*logo$/i, /^\s*$/,
  /\.(png|jpg|jpeg|svg|webp|gif)$/i,
];

function isJunk(s: string): boolean {
  if (!s || s.length > 80) return true;
  if (s.length < 2) return true;
  return JUNK_PATTERNS.some((re) => re.test(s));
}

const CASE_PREFIX = /^(?:кейс|case|case study|клиент|проект|project)\s*[:—\-–]\s*(.+)$/i;

function cleanCaseTitle(title: string): string {
  const m = title.match(CASE_PREFIX);
  if (m && m[1].trim()) return m[1].trim();
  return title.trim();
}

const LOGO_CONTAINER_SELECTOR = [
  '[class*="client"] img[alt]', '[class*="customer"] img[alt]',
  '[class*="-logos"] img[alt]', '[class*="_logos"] img[alt]',
  '[class*="partner"] img[alt]', '[class*="trust"] img[alt]',
  '[class*="brand"] img[alt]', '[class*="company"] img[alt]',
].join(', ');

const CASE_CARD_SELECTOR = [
  '[class*="case-card"]', '[class*="case-item"]', '[class*="case-study"]',
  '[class*="client-card"]', '[class*="client-item"]',
  '[class*="portfolio-item"]', '[class*="portfolio-card"]',
  '[class*="project-card"]', '[class*="project-item"]',
  '[class*="work-item"]', '[class*="work-card"]',
  '[class*="success-story"]',
].join(', ');

const SECTION_HEADING_RE = /(?:наши\s+)?клиенты|нам\s+доверяют|(?:наши\s+)?партнёры|(?:наши\s+)?партнеры|они\s+(?:выбрали|доверяют|работают)|(?:our\s+)?clients|(?:our\s+)?customers|trusted\s+by|(?:our\s+)?partners|who\s+(?:we\s+)?work\s+with/i;

function addName(s: string, seen: Set<string>, result: string[], cap: number): void {
  if (result.length >= cap) return;
  const cleaned = cleanCaseTitle(s);
  if (isJunk(cleaned)) return;
  const key = cleaned.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  result.push(cleaned);
}

export function extractCustomers(html: string): string[] {
  if (!html) return [];
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const result: string[] = [];
  const cap = 30;

  // Strategy 1: img alt text in logo containers
  $(LOGO_CONTAINER_SELECTOR).each((_, el) => {
    addName(($(el).attr('alt') ?? '').trim(), seen, result, cap);
  });

  // Strategy 2: case/project card headings
  if (result.length < cap) {
    $(CASE_CARD_SELECTOR).each((_, container) => {
      const heading = $(container).find('h2, h3, h4').first().text().trim();
      if (heading) addName(heading, seen, result, cap);
    });
  }

  // Strategy 3: find sections by heading text ("Наши клиенты", "Нам доверяют", etc.)
  if (result.length < cap) {
    $('h1, h2, h3, h4, [class*="title"], [class*="heading"]').each((_, heading) => {
      if (result.length >= cap) return false;
      const text = $(heading).text().trim();
      if (!SECTION_HEADING_RE.test(text)) return;

      const section = $(heading).parent();
      // Extract from img alt in the section
      section.find('img[alt]').each((__, img) => {
        addName(($(img).attr('alt') ?? '').trim(), seen, result, cap);
      });
      // Extract from list items or linked names
      section.find('li, a, h3, h4, h5').each((__, item) => {
        const t = $(item).text().trim();
        if (t && t.length >= 2 && t.length <= 60 && !SECTION_HEADING_RE.test(t)) {
          addName(t, seen, result, cap);
        }
      });
    });
  }

  return result.slice(0, cap);
}

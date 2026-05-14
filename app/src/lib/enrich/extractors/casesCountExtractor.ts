import * as cheerio from 'cheerio';

const CASE_SELECTOR = [
  '[class*="case-card"]', '[class*="case-item"]', '[class*="case-study"]',
  '[class*="client-card"]', '[class*="client-item"]',
  '[class*="portfolio-item"]', '[class*="portfolio-card"]',
  '[class*="project-card"]', '[class*="project-item"]',
  '[class*="work-item"]', '[class*="work-card"]',
  '[class*="success-story"]',
].join(', ');

const MAX_CASES = 200;

const TEXT_COUNT_RE = /(?:более\s+|свыше\s+|>?\s*)(\d+)\s*(?:\+\s*)?(?:кейс|проект|работ|клиент|case|project|client)/i;
const TEXT_COUNT_RE2 = /(\d+)\s*\+?\s*(?:выполненных|реализованных|завершённых|завершенных|успешных)/i;

export function extractCasesCount(html: string): number {
  if (!html) return 0;
  const $ = cheerio.load(html);

  const matched = $(CASE_SELECTOR);
  let domCount = 0;
  matched.each((_, el) => {
    const isNested = $(el).parents(CASE_SELECTOR).length > 0;
    if (!isNested) domCount++;
  });
  if (domCount > 0) return Math.min(domCount, MAX_CASES);

  const text = $('body').text();
  const m = text.match(TEXT_COUNT_RE) ?? text.match(TEXT_COUNT_RE2);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n > 0 && n <= MAX_CASES) return n;
  }

  return 0;
}

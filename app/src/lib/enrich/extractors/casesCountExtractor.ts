import * as cheerio from 'cheerio';

const CASE_SELECTOR = [
  '[class*="case-card"]', '[class*="case-item"]', '[class*="case-study"]',
  '[class*="client-card"]', '[class*="client-item"]',
  '[class*="portfolio-item"]', '[class*="portfolio-card"]',
  '[class*="project-card"]', '[class*="project-item"]',
  '[class*="work-item"]', '[class*="work-card"]',
  '[class*="success-story"]',
].join(', ');

// Realistic upper bound for what a real agency portfolio actually publishes
// on a page. Anything above this is almost always a CMS that emits 100+ items
// matching our `case-*` selector for unrelated reasons (blog listings, nav
// widgets, hidden carousel duplicates) — the count is no longer trustworthy.
const MAX_CASES = 100;
// When DOM matches go above this without a corroborating text claim, we
// treat the count as untrusted (returns 0) so the LLM fallback can decide.
const DOM_TRUST_LIMIT = 60;

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

  const text = $('body').text();
  const textMatch = text.match(TEXT_COUNT_RE) ?? text.match(TEXT_COUNT_RE2);
  const textClaim = textMatch ? parseInt(textMatch[1], 10) : 0;

  // High DOM counts without an explicit textual claim are almost always a
  // selector false-positive (CMS list widgets, footers, blog grids). Drop the
  // count so the LLM fallback can produce a real number.
  if (domCount > DOM_TRUST_LIMIT && textClaim <= 0) return 0;

  if (domCount > 0) return Math.min(domCount, MAX_CASES);
  if (textClaim > 0) return Math.min(textClaim, MAX_CASES);
  return 0;
}

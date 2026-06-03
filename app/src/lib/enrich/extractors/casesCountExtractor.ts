import * as cheerio from 'cheerio';

const CASE_SELECTOR = [
  '[class*="case-card"]', '[class*="case-item"]', '[class*="case-study"]',
  '[class*="client-card"]', '[class*="client-item"]',
  '[class*="portfolio-item"]', '[class*="portfolio-card"]',
  '[class*="project-card"]', '[class*="project-item"]',
  '[class*="work-item"]', '[class*="work-card"]',
  '[class*="success-story"]',
].join(', ');

// Realistic upper bound for a case-portfolio published on one page. Above
// this most counts are inflated by CMS list widgets / blog grids, so we cap
// here and let the LLM fallback produce a precise number if available.
const MAX_CASES = 50;
// Strict DOM count is trusted up to this; beyond it we require a textual
// claim with a reasonable value to confirm.
const DOM_TRUST_LIMIT = 30;
// Marketing claims like "5000+ проектов" are almost always puff — we trust
// the text claim only when it falls inside this window.
const REASONABLE_TEXT_CLAIM_MAX = 200;

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
  const rawTextClaim = textMatch ? parseInt(textMatch[1], 10) : 0;
  const textClaim = rawTextClaim > 0 && rawTextClaim <= REASONABLE_TEXT_CLAIM_MAX ? rawTextClaim : 0;

  // Strict, modest DOM count → trust it.
  if (domCount > 0 && domCount <= DOM_TRUST_LIMIT) return domCount;

  // Inflated DOM count: only believe a reasonable text claim, otherwise drop.
  if (domCount > DOM_TRUST_LIMIT) {
    if (textClaim > 0) return Math.min(textClaim, MAX_CASES);
    return 0;
  }

  // No DOM matches: text claim alone is acceptable.
  if (textClaim > 0) return Math.min(textClaim, MAX_CASES);

  return 0;
}

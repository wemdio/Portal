import * as cheerio from 'cheerio';

const CASE_SELECTOR = '[class~="case-card"], [class~="client-card"], [class~="case-item"]';

const MAX_CASES = 200;

export function extractCasesCount(html: string): number {
  if (!html) return 0;
  const $ = cheerio.load(html);
  return Math.min($(CASE_SELECTOR).length, MAX_CASES);
}

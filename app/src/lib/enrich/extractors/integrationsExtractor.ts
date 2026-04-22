import * as cheerio from 'cheerio';

const INTEGRATION_SELECTOR =
  '[class*="integration"] img[alt], [class*="partner"] img[alt]';

const JUNK_RE: RegExp[] = [
  /^logo$/i,
  /^image$/i,
  /^icon$/i,
  /^photo$/i,
  /^avatar$/i,
  /^client logo$/i,
  /^logo\s*\d*$/i,
  /^\s*\d+\s*$/,
  /^$/,
];

function isJunk(s: string): boolean {
  if (!s || s.length > 60) return true;
  return JUNK_RE.some((re) => re.test(s.trim()));
}

const MAX_INTEGRATIONS = 20;

export function extractIntegrations(html: string): string[] {
  if (!html) return [];
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const result: string[] = [];

  $(INTEGRATION_SELECTOR).each((_, el) => {
    if (result.length >= MAX_INTEGRATIONS) return false;
    const alt = ($(el).attr('alt') ?? '').trim();
    if (isJunk(alt)) return;
    const key = alt.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(alt);
  });

  return result.slice(0, MAX_INTEGRATIONS);
}

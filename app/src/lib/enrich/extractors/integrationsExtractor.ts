import * as cheerio from 'cheerio';

const IMG_SELECTOR = [
  '[class*="integration"] img[alt]', '[class*="partner"] img[alt]',
  '[class*="connector"] img[alt]', '[class*="app-card"] img[alt]',
  '[class*="ecosystem"] img[alt]', '[class*="marketplace"] img[alt]',
  '[class*="compatible"] img[alt]', '[class*="connect"] img[alt]',
].join(', ');

const JUNK_RE: RegExp[] = [
  /^logo$/i, /^image$/i, /^icon$/i, /^photo$/i, /^avatar$/i,
  /^client logo$/i, /^logo\s*\d*$/i, /^\s*\d+\s*$/, /^$/,
  /^img$/i, /^picture$/i, /^banner$/i,
];

const URL_RE = /^https?:\/\//i;
const LOGO_DESCRIPTION_RE = /^(?:лого(?:тип)?|logo)\s+/i;

function isJunk(s: string): boolean {
  if (!s || s.length > 80) return true;
  if (s.length < 2) return true;
  if (URL_RE.test(s)) return true;
  if (JUNK_RE.some((re) => re.test(s.trim()))) return true;
  return false;
}

function cleanName(s: string): string {
  return s.replace(LOGO_DESCRIPTION_RE, '').trim();
}

const SECTION_HEADING_RE = /интеграци|подключени|совместимост|экосистем|integrations?|connectors?|apps?\s+(?:we|&)|works?\s+with|compatible/i;

const MAX_INTEGRATIONS = 20;

export function extractIntegrations(html: string): string[] {
  if (!html) return [];
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const result: string[] = [];

  function addName(raw: string): void {
    if (result.length >= MAX_INTEGRATIONS) return;
    const cleaned = cleanName(raw);
    if (isJunk(cleaned)) return;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(cleaned);
  }

  // Strategy 1: img alt in integration containers
  $(IMG_SELECTOR).each((_, el) => {
    addName(($(el).attr('alt') ?? '').trim());
  });

  // Strategy 2: find sections by heading text
  if (result.length < MAX_INTEGRATIONS) {
    $('h1, h2, h3, h4, [class*="title"], [class*="heading"]').each((_, heading) => {
      if (result.length >= MAX_INTEGRATIONS) return false;
      const text = $(heading).text().trim();
      if (!SECTION_HEADING_RE.test(text)) return;

      const section = $(heading).parent();
      section.find('img[alt]').each((__, img) => {
        addName(($(img).attr('alt') ?? '').trim());
      });
      section.find('li, a, h3, h4, h5, span').each((__, item) => {
        const t = $(item).text().trim();
        if (t && t.length >= 2 && t.length <= 40 && !SECTION_HEADING_RE.test(t)) {
          addName(t);
        }
      });
    });
  }

  return result.slice(0, MAX_INTEGRATIONS);
}

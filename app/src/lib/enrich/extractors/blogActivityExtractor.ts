import * as cheerio from 'cheerio';

const RU_MONTH_PREFIXES: Array<[string, string]> = [
  ['январ', '01'],
  ['феврал', '02'],
  ['март', '03'],
  ['апрел', '04'],
  ['май', '05'], ['мая', '05'], ['мае', '05'],
  ['июн', '06'],
  ['июл', '07'],
  ['август', '08'],
  ['сентябр', '09'],
  ['октябр', '10'],
  ['ноябр', '11'],
  ['декабр', '12'],
];

function parseIsoDate(s: string): string | null {
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function parseRuDate(s: string): string | null {
  const m = s.toLowerCase().match(/(\d{1,2})\s+([а-яё]+)\s+(\d{4})/);
  if (!m) return null;
  const day = m[1].padStart(2, '0');
  const monthRaw = m[2];
  const year = m[3];
  for (const [prefix, num] of RU_MONTH_PREFIXES) {
    if (monthRaw.startsWith(prefix)) {
      return `${year}-${num}-${day}`;
    }
  }
  return null;
}

const DATE_TEXT_SELECTOR = '[class~="post-date"], [class~="entry-date"], [class~="article-date"], [class~="publish-date"]';

export function extractBlogLastPost(html: string): string | undefined {
  if (!html) return undefined;
  const $ = cheerio.load(html);
  const dates: string[] = [];

  $('time[datetime]').each((_, el) => {
    const dt = $(el).attr('datetime') ?? '';
    const iso = parseIsoDate(dt);
    if (iso) dates.push(iso);
  });

  $(DATE_TEXT_SELECTOR).each((_, el) => {
    const t = $(el).text().trim();
    const iso = parseIsoDate(t) ?? parseRuDate(t);
    if (iso) dates.push(iso);
  });

  if (dates.length === 0) return undefined;

  const today = new Date();
  const cutoffMs = today.getTime() + 7 * 24 * 3600 * 1000;
  const cutoff = new Date(cutoffMs);
  const cutoffIso = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`;

  const filtered = dates.filter((d) => d <= cutoffIso);
  if (filtered.length === 0) return undefined;

  return filtered.sort().reverse()[0];
}

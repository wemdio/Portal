import * as cheerio from 'cheerio';

const VACANCY_SELECTOR = [
  '[class*="vacancy"]', '[class*="vacancies"]',
  '[class*="job-card"]', '[class*="job-item"]', '[class*="job-listing"]', '[class*="job_item"]',
  '[class*="job "]', '[class="job"]',
  '[class*="position"]',
  '[class*="career-item"]', '[class*="career-card"]',
  '[class*="opening-item"]', '[class*="opening-card"]', '[class*="opening"]',
].join(', ');

const MAX_VACANCIES = 500;
const MAX_PROFESSIONS_RETURNED = 5;

// Two shapes both common in copy:
//   "12 открытых вакансий"   — number first
//   "Открытых вакансий: 12"  — number last
// The processor picks whichever fires first; both write the same digit group
// into match[1] / match[2] so the parseInt downstream is symmetrical.
const VACANCY_TEXT_COUNT_RE =
  /(?:(\d+)\s*(?:\+\s*)?(?:вакан|открыт|позици|open\s+position|job opening)|(?:вакан\w*|открытых\s+вакансий|открыт\w+\s+позиций|open\s+position|job\s+opening)[^.\n]{0,20}?(\d+))/i;

// External career pages we can extract from when the company has no /careers
// of its own but links out to an aggregator. Most RU B2B companies that hire
// publicly use hh.ru/employer/<id> or career.habr.com/companies/<slug>.
const EXTERNAL_CAREER_HOSTS_RE =
  /^https?:\/\/(?:[\w-]+\.)?(?:hh\.ru\/employer\/\d|career\.habr\.com\/companies\/[\w-]|career\.habr\.com\/companies\?|getmatch\.ru\/companies\/[\w-]|sm-art\.com\/c\/[\w-]|huntmore\.io\/c\/[\w-])/i;

/**
 * Locate external career-page URLs linked from the main page (hh.ru/employer,
 * career.habr.com/companies, ...). The processor uses these as a fallback when
 * the company has no /careers subpage of its own but does publish vacancies
 * via an aggregator.
 */
export function findExternalCareerLinks(html: string): string[] {
  if (!html) return [];
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    if (!href) return;
    if (EXTERNAL_CAREER_HOSTS_RE.test(href)) {
      // Strip trailing query/fragment to avoid duplicates for the same page.
      const clean = href.replace(/[?#].*$/, '');
      seen.add(clean);
    }
  });
  return Array.from(seen).slice(0, 3);
}

/**
 * Result of analyzing a /careers (or aggregator) page.
 *
 * History: the legacy shape was 5 bool flags
 * `{ has_marketing, has_engineering, has_sales, has_design, has_product }`.
 * That tuned the column for B2B SaaS / agencies and silently returned all-
 * false on industrial / HoReCa / construction / professional-services
 * segments — they don't hire marketers or product managers, they hire
 * лифтёров, монтажников, бариста, поваров. Ксения's 09.06 feedback (МОСЛИФТ
 * et al.) was 0% fill on "Кого нанимают" across 20 industrial companies even
 * though several of them had real vacancy pages.
 *
 * The new shape returns up to `MAX_PROFESSIONS_RETURNED` concrete profession
 * tokens extracted from the actual vacancy titles, sorted by frequency. The
 * applier renders them as a comma-joined string ("Лифтёры, Монтажники,
 * Диспетчеры") so operators can paste that straight into outreach copy.
 *
 * vacancies_count stays a plain number — orthogonal signal.
 */
export interface HiringResult {
  vacancies_count: number;
  professions: string[];
}

const LEVEL_PREFIX_RE =
  /^(?:senior|sr\.?|middle|mid\.?|junior|jr\.?|lead|principal|chief|head|старший|младший|ведущий|главный|помощник|стажёр|стажер|intern|trainee)\s+/i;

// Salary fragments inside the title text. Promka vacancy widgets often inline
// the salary like "Электромонтажник — от 80 000 ₽" — strip the trailing money.
const SALARY_TAIL_RE =
  /\s+(?:от|до|от\s+\d|до\s+\d)\s*\d[\d\s.,]*\s*(?:₽|руб|рублей|usd|eur|\$|€)?[^\s]*?$/i;
// No trailing `\b` — JS `\b` doesn't fire after Cyrillic, so "Слесарь 100
// 000 руб" would slip through. The greedy `.*$` plus the currency anchor
// already ensures we eat the whole salary tail.
const PLAIN_SALARY_RE =
  /\s+\d[\d\s.,]*\s*(?:₽|руб[а-яё]*|usd|eur|\$|€).*$/i;

const LOCATION_TAIL_RE =
  /\s+(?:в|на)\s+(?:Москве|Москву|СПб|Санкт-Петербурге|Питере|Казани|Краснодаре|Новосибирске|Екатеринбурге|удал[ёе]нн?о|онлайн).*$/i;

const MODE_TAIL_RE =
  /\s+(?:полный\s+день|полная\s+занятость|удал[ёе]нн?[ое]|вахт[аыое]|сменн[ыоае]\w*|неполн\w+\s+день|часть\s+ставки|подработк[аи]|стажировк[аи]).*$/i;

const NOISE_WORD_RE = /(?:можно\s+без|с\s+опыт[а-яё]+|опыт\s+от|з\/п|з\.\s*п\.)/i;

/**
 * Reduce a raw vacancy title to a short profession noun-phrase suitable for
 * pasting into outreach copy. Strips level prefixes, salary, location, work-
 * mode, parenthetical qualifiers, and post-comma noise. Caps the result at
 * 4 tokens — single-noun professions ("Лифтёр") and 2-3 word phrases
 * ("Менеджер по продажам", "Главный бухгалтер") are both natural fits.
 *
 * Returns '' if nothing meaningful is left.
 */
export function extractProfession(rawTitle: string): string {
  let t = String(rawTitle ?? '').trim();
  if (!t) return '';

  // Drop everything after a parenthetical / bracket — it's almost always a
  // qualifier ("(Senior)", "[удалённо]", "(г. Москва)") and rarely part of
  // the actual profession noun.
  t = t.replace(/\s*[(\[\{].+$/, '').trim();

  // Drop everything after a slash / em-dash / comma when the trailing part
  // looks like a qualifier rather than a continuation of the profession.
  // (We don't want to butcher "Менеджер по работе с клиентами" — there are
  // no separators inside it.) Comma-separated tails are usually locations,
  // salary, or schedule notes — pruning aggressively is the right call.
  t = t.replace(/\s*[,/]\s*.+$/, '').trim();
  t = t.replace(/\s*[—–\-]\s+(?:от|с\s+|до|от\s+|вахта|удал|полн|сменн).+$/i, '').trim();

  // Strip level prefix only if it leads — never inside the phrase.
  t = t.replace(LEVEL_PREFIX_RE, '').trim();

  // Strip salary and location tails.
  t = t.replace(SALARY_TAIL_RE, '').trim();
  t = t.replace(PLAIN_SALARY_RE, '').trim();
  t = t.replace(LOCATION_TAIL_RE, '').trim();
  t = t.replace(MODE_TAIL_RE, '').trim();

  // Reject noise titles that are clearly UI fragments rather than real
  // vacancy names (carousel labels, "Все вакансии" links, etc.).
  if (NOISE_WORD_RE.test(t)) return '';
  if (/^(?:все\s+вакансии|открытые\s+вакансии|career|вакансии|jobs)\s*$/i.test(t)) return '';

  // Cap to 4 tokens. Real profession noun-phrases are short
  // ("Электромонтажник по силовым сетям" = 4 tokens, "Менеджер" = 1).
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > 4) t = words.slice(0, 4).join(' ');

  t = t.trim();
  // Discard if too short — single-character or 2-letter snippets are noise.
  if (t.length < 3) return '';

  return t;
}

/**
 * Aggregate cleaned profession names into a frequency-ranked list. Case-
 * insensitive dedup; the first-seen casing wins so the final list reads
 * naturally ("Лифтёр" not "лифтёр"). Capped at `cap` entries.
 */
function aggregateProfessions(titles: string[], cap: number): string[] {
  const counter = new Map<string, { count: number; canonical: string }>();
  for (const title of titles) {
    const prof = extractProfession(title);
    if (!prof) continue;
    const key = prof.toLowerCase();
    const existing = counter.get(key);
    if (existing) existing.count += 1;
    else counter.set(key, { count: 1, canonical: prof });
  }
  return Array.from(counter.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, cap)
    .map((v) => v.canonical);
}

export function extractHiring(html: string): HiringResult {
  if (!html) {
    return { vacancies_count: 0, professions: [] };
  }

  const $ = cheerio.load(html);
  const elements = $(VACANCY_SELECTOR);
  const titles: string[] = [];
  elements.each((_, el) => {
    const t = $(el).text().trim();
    if (t) titles.push(t);
  });

  let vacancies_count = Math.min(elements.length, MAX_VACANCIES);

  if (vacancies_count === 0) {
    const bodyText = $('body').text();
    const m = bodyText.match(VACANCY_TEXT_COUNT_RE);
    if (m) {
      // Either capturing group may carry the number depending on which side
      // of the alternation matched.
      const raw = m[1] ?? m[2];
      const n = raw ? parseInt(raw, 10) : 0;
      if (n > 0 && n <= MAX_VACANCIES) vacancies_count = n;
    }
  }

  const professions = aggregateProfessions(titles, MAX_PROFESSIONS_RETURNED);

  return {
    vacancies_count,
    professions,
  };
}

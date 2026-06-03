import * as cheerio from 'cheerio';

const VACANCY_SELECTOR = [
  '[class*="vacancy"]', '[class*="vacancies"]',
  '[class*="job-card"]', '[class*="job-item"]', '[class*="job-listing"]', '[class*="job_item"]',
  '[class*="job "]', '[class="job"]',
  '[class*="position"]',
  '[class*="career-item"]', '[class*="career-card"]',
  '[class*="opening-item"]', '[class*="opening-card"]', '[class*="opening"]',
].join(', ');

const MARKETING_PATTERNS: RegExp[] = [
  /\bmarket(?:ing|er|ers)\b/i, /\bsmm\b/i, /\bppc\b/i, /\bseo\b/i, /\bperformance\b/i,
  /\bgrowth\b/i, /\bbrand(?:ing)?\b/i, /\bcommunication/i, /\bcontent (?:lead|manager|specialist|writer)\b/i,
  /маркет/i, /пиар/i, /бренд[-\s]/i, /контент[-\s]/i, /таргет/i,
];

const ENGINEERING_PATTERNS: RegExp[] = [
  /\bdeveloper\b/i, /\bengineer\b/i, /\bdevops\b/i, /\bsre\b/i,
  /\barchitect\b/i, /\bfrontend\b/i, /\bbackend\b/i, /\bfullstack\b/i,
  /\bqa\b/i, /\bdata scientist\b/i, /\bml engineer\b/i,
  /\bразработчик\b/i, /\bпрограммист\b/i, /\bинженер\b/i, /\bтестировщик\b/i,
  /\bбэкенд\b/i, /\bфронтенд\b/i, /\bдевопс\b/i,
];

const SALES_PATTERNS: RegExp[] = [
  /\bsales\b/i, /\baccount executive\b/i, /\bsdr\b/i, /\bbdr\b/i,
  /\baccount manager\b/i, /\bbusiness development\b/i, /\bcustomer success\b/i,
  /\bменеджер по продажам\b/i, /\bпродаж/i, /\bаккаунт[-\s]?менеджер\b/i,
];

const DESIGN_PATTERNS: RegExp[] = [
  /\bdesigner\b/i, /\bux\b/i, /\bui\b/i, /\bux\/ui\b/i, /\bui\/ux\b/i,
  /\bgraphic designer\b/i, /\bproduct designer\b/i, /\bvisual designer\b/i,
  /\bweb designer\b/i, /\billustrat/i, /\bmotion design/i,
  /\bдизайнер\b/i, /\bграфический дизайн/i, /\bвеб[-\s]?дизайн/i,
];

const PRODUCT_PATTERNS: RegExp[] = [
  /\bproduct manager\b/i, /\bproduct owner\b/i, /\bproduct lead\b/i,
  /\bpm\b/i, /\bpo\b/i, /\bproduct analyst\b/i,
  /\bпродуктовый менеджер\b/i, /\bпродакт[-\s]?менеджер\b/i,
  /\bпродакт[-\s]?оунер\b/i, /\bвладелец продукта\b/i,
];

const MAX_VACANCIES = 500;

const VACANCY_TEXT_COUNT_RE = /(\d+)\s*(?:\+\s*)?(?:вакан|открыт|позици|open\s+position|job opening)/i;

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

export interface HiringResult {
  vacancies_count: number;
  has_marketing: boolean;
  has_engineering: boolean;
  has_sales: boolean;
  has_design: boolean;
  has_product: boolean;
}

export function extractHiring(html: string): HiringResult {
  if (!html) {
    return { vacancies_count: 0, has_marketing: false, has_engineering: false, has_sales: false, has_design: false, has_product: false };
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
      const n = parseInt(m[1], 10);
      if (n > 0 && n <= MAX_VACANCIES) vacancies_count = n;
    }
  }

  const allText = vacancies_count > 0 && titles.length > 0
    ? titles.join(' | ')
    : $('body').text();

  return {
    vacancies_count,
    has_marketing: MARKETING_PATTERNS.some((re) => re.test(allText)),
    has_engineering: ENGINEERING_PATTERNS.some((re) => re.test(allText)),
    has_sales: SALES_PATTERNS.some((re) => re.test(allText)),
    has_design: DESIGN_PATTERNS.some((re) => re.test(allText)),
    has_product: PRODUCT_PATTERNS.some((re) => re.test(allText)),
  };
}

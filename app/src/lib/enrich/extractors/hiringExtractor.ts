import * as cheerio from 'cheerio';

const VACANCY_SELECTOR = [
  '[class~="vacancy"]',
  '[class~="vacancies"]',
  '[class~="job"]',
  '[class~="job-card"]',
  '[class~="position"]',
  '[class~="career"]',
  '[class~="opening"]',
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

const MAX_VACANCIES = 500;

export interface HiringResult {
  vacancies_count: number;
  has_marketing: boolean;
  has_engineering: boolean;
  has_sales: boolean;
}

export function extractHiring(html: string): HiringResult {
  if (!html) {
    return { vacancies_count: 0, has_marketing: false, has_engineering: false, has_sales: false };
  }

  const $ = cheerio.load(html);
  const elements = $(VACANCY_SELECTOR);
  const titles: string[] = [];
  elements.each((_, el) => {
    const t = $(el).text().trim();
    if (t) titles.push(t);
  });

  const vacancies_count = Math.min(elements.length, MAX_VACANCIES);
  const allText = titles.join(' | ');

  return {
    vacancies_count,
    has_marketing: MARKETING_PATTERNS.some((re) => re.test(allText)),
    has_engineering: ENGINEERING_PATTERNS.some((re) => re.test(allText)),
    has_sales: SALES_PATTERNS.some((re) => re.test(allText)),
  };
}

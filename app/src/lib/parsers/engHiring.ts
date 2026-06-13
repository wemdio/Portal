import {
  careersUrl,
  domainFromJobUrls,
  normalizeJob,
} from '@/lib/jobs/atsCompanyParser';
import { ATS_COUNTRIES, buildCountryRegex, buildRolesRegex } from '@/lib/parsers/atsFilters';

export type EngHiringSource = 'greenhouse' | 'lever' | 'ashby' | 'workable' | 'bamboohr' | 'recruitee';

export const ENG_HIRING_SOURCES: EngHiringSource[] = ['greenhouse', 'lever', 'ashby', 'workable', 'bamboohr', 'recruitee'];

export interface EngHiringSearchConfig {
  text?: string;
  sources?: EngHiringSource[];
  countries?: string[];
  posted_within_days?: number;
  companies_limit?: number;
  max_results?: number;
  cache_max_age_hours?: number;
  refresh_cache?: boolean;
  enrich?: boolean;
  now?: string;
}

export interface EngHiringVacancy {
  source: EngHiringSource;
  source_company_slug: string;
  source_job_id: string;
  company_name: string;
  company_site_url: string | null;
  company_description: string | null;
  vacancy_title: string;
  vacancy_description: string | null;
  vacancy_url: string;
  careers_url: string | null;
  location: string | null;
  city: string | null;
  country: string | null;
  country_code: string | null;
  salary_from: number | null;
  salary_to: number | null;
  salary_currency: string | null;
  published_at: string | null;
  raw: unknown;
}

type NormalizedAtsJob = {
  ats: string;
  slug: string;
  company: string;
  title: string;
  location: string;
  country: string;
  url: string;
  posted_at: string;
};

type NormalizeContext = {
  slug?: string;
  companyName?: string;
};

const COUNTRY_NAME_BY_CODE: Record<string, string> = {
  us: 'United States',
  gb: 'United Kingdom',
  ca: 'Canada',
  de: 'Germany',
  fr: 'France',
  nl: 'Netherlands',
  ie: 'Ireland',
  es: 'Spain',
  au: 'Australia',
  sg: 'Singapore',
  remote: 'Remote',
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value) return value;
  }
  return '';
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[^\d.]/g, '');
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function cleanHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanPlainText(value: unknown): string {
  return cleanHtml(value)
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*>\s*/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = numberValue(record[key]);
    if (value != null) return value;
  }
  return null;
}

function parseSalaryString(value: string): { from: number | null; to: number | null; currency: string | null } {
  const text = value.trim();
  if (!text) return { from: null, to: null, currency: null };
  const currency =
    /\bUSD\b|\$/.test(text) ? 'USD'
      : /\bGBP\b|£/.test(text) ? 'GBP'
      : /\bEUR\b|€/.test(text) ? 'EUR'
      : null;
  const nums = [...text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(k|K)?/g)]
    .map((m) => {
      const base = Number(m[1].replace(/,/g, ''));
      if (!Number.isFinite(base)) return null;
      return Math.round(base * (m[2] ? 1000 : 1));
    })
    .filter((n): n is number => n != null && n > 0);
  if (nums.length === 0) return { from: null, to: null, currency };
  if (nums.length === 1) return { from: nums[0], to: null, currency };
  return { from: Math.min(nums[0], nums[1]), to: Math.max(nums[0], nums[1]), currency };
}

function extractNestedString(record: Record<string, unknown>, path: string[]): string {
  let current: unknown = record;
  for (const key of path) {
    const r = asRecord(current);
    if (!r) return '';
    current = r[key];
  }
  return stringValue(current);
}

function extractDescription(raw: unknown): string | null {
  if (typeof raw === 'string') {
    const text = cleanPlainText(raw);
    return text || null;
  }

  const record = asRecord(raw);
  if (!record) return null;

  const candidates = [
    record.descriptionPlain,
    record.description_plain,
    record.description,
    record.descriptionHtml,
    record.description_html,
    record.content,
    record.job_description,
    record.jobDescription,
    record.highlight,
    record.requirements,
    extractNestedString(record, ['details', 'description']),
    extractNestedString(record, ['opening', 'description']),
    extractNestedString(record, ['result', 'jobOpening', 'description']),
  ];

  for (const candidate of candidates) {
    const text = cleanHtml(candidate);
    if (text) return text;
  }
  return null;
}

function extractSalaryFromDescription(description: string | null): { from: number | null; to: number | null; currency: string | null } {
  if (!description) return { from: null, to: null, currency: null };
  const labelled = description.match(
    /(?:salary|compensation|pay\s+range|base\s+(?:pay|salary|range)|OTE|on[-\s]?target)\s*[:\-]?\s*([^.!?\n]{0,160})/i,
  );
  if (labelled?.[1]) {
    const parsed = parseSalaryString(labelled[1]);
    if (parsed.from != null || parsed.to != null || parsed.currency) return parsed;
  }

  const chunks = description
    .split(/(?<=[.!?])\s+|\n+/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => /salary|compensation|pay\s+range|base\s+(?:pay|salary|range)|OTE|on[-\s]?target/i.test(chunk));

  for (const chunk of chunks) {
    const parsed = parseSalaryString(chunk);
    if (parsed.from != null || parsed.to != null || parsed.currency) return parsed;
  }
  return { from: null, to: null, currency: null };
}

function extractSalary(raw: unknown): { from: number | null; to: number | null; currency: string | null } {
  if (typeof raw === 'string') return extractSalaryFromDescription(cleanPlainText(raw));

  const record = asRecord(raw);
  if (!record) return { from: null, to: null, currency: null };

  const candidates = [
    record.salary,
    record.compensation,
    record.payRange,
    record.pay_range,
    record.compensationRange,
    record.compensation_range,
    extractNestedString(record, ['result', 'jobOpening', 'compensation']),
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const parsed = parseSalaryString(candidate);
      if (parsed.from != null || parsed.to != null || parsed.currency) return parsed;
      continue;
    }
    const c = asRecord(candidate);
    if (!c) continue;
    const from = firstNumber(c, ['min_value', 'minValue', 'minimum', 'min', 'from', 'salary_min', 'low']);
    const to = firstNumber(c, ['max_value', 'maxValue', 'maximum', 'max', 'to', 'salary_max', 'high']);
    const currency = firstString(c, ['currency', 'currency_code', 'currencyCode']).toUpperCase() || null;
    if (from != null || to != null || currency) return { from, to, currency };
  }

  const directFrom = firstNumber(record, ['salary_min', 'salaryMin', 'min_salary', 'minSalary']);
  const directTo = firstNumber(record, ['salary_max', 'salaryMax', 'max_salary', 'maxSalary']);
  const directCurrency = firstString(record, ['salary_currency', 'salaryCurrency', 'currency']).toUpperCase() || null;
  if (directFrom != null || directTo != null || directCurrency) {
    return { from: directFrom, to: directTo, currency: directCurrency };
  }

  return extractSalaryFromDescription(extractDescription(raw));
}

function extractUrlJobId(url: string): string {
  try {
    const parsed = new URL(url);
    const ghId = parsed.searchParams.get('gh_jid');
    if (ghId) return ghId;
    const parts = parsed.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] ?? '';
  } catch {
    return '';
  }
}

function extractSourceJobId(raw: unknown, vacancyUrl: string): string {
  const record = asRecord(raw);
  if (record) {
    const id = firstString(record, [
      'id',
      'job_id',
      'jobId',
      'gh_jid',
      'shortcode',
      'guid',
      'requisition_id',
      'requisitionId',
      'jobPostingId',
    ]);
    if (id) return id;
  }
  return extractUrlJobId(vacancyUrl);
}

function parseCity(location: string | null): string | null {
  const value = (location ?? '').trim();
  if (!value || /remote|anywhere|distributed/i.test(value)) return value || null;
  const first = value.split(',')[0]?.trim();
  return first || null;
}

function normalizeIsoDate(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function inferCountryCode(location?: string | null, country?: string | null): string | null {
  const haystack = `${country ?? ''} ${location ?? ''}`.trim();
  if (!haystack) return null;
  for (const item of ATS_COUNTRIES) {
    if (new RegExp(item.match, 'i').test(haystack)) return item.code;
  }
  return null;
}

export function normalizeAtsJobToEngVacancy(
  source: EngHiringSource,
  raw: unknown,
  ctx: NormalizeContext = {},
): EngHiringVacancy | null {
  const normalized = normalizeJob(source, raw, ctx) as NormalizedAtsJob | null;
  if (!normalized?.title || !normalized.company || !normalized.url) return null;

  const sourceJobId = extractSourceJobId(raw, normalized.url);
  if (!sourceJobId) return null;

  const domain = domainFromJobUrls([normalized.url]);
  const countryCode = inferCountryCode(normalized.location, normalized.country);
  const description = extractDescription(raw);
  const salary = extractSalary(raw);

  return {
    source,
    source_company_slug: normalized.slug || ctx.slug || '',
    source_job_id: sourceJobId,
    company_name: normalized.company,
    company_site_url: domain ? `https://${domain}` : null,
    company_description: null,
    vacancy_title: normalized.title,
    vacancy_description: description,
    vacancy_url: normalized.url,
    careers_url: normalized.slug ? careersUrl(source, normalized.slug) : null,
    location: normalized.location || null,
    city: parseCity(normalized.location || null),
    country: normalized.country || (countryCode ? COUNTRY_NAME_BY_CODE[countryCode] ?? null : null),
    country_code: countryCode,
    salary_from: salary.from,
    salary_to: salary.to,
    salary_currency: salary.currency,
    published_at: normalizeIsoDate(normalized.posted_at),
    raw,
  };
}

export function mergeEngHiringVacancyDetail(vacancy: EngHiringVacancy, detailRaw: unknown): EngHiringVacancy {
  const description = extractDescription(detailRaw);
  const salary = extractSalary(detailRaw);
  const domain = domainFromJobUrls([vacancy.vacancy_url, firstString(asRecord(detailRaw) ?? {}, ['absolute_url', 'hostedUrl', 'jobUrl'])]);

  return {
    ...vacancy,
    company_site_url: vacancy.company_site_url ?? (domain ? `https://${domain}` : null),
    vacancy_description: vacancy.vacancy_description ?? description,
    salary_from: vacancy.salary_from ?? salary.from,
    salary_to: vacancy.salary_to ?? salary.to,
    salary_currency: vacancy.salary_currency ?? salary.currency,
    raw: detailRaw || vacancy.raw,
  };
}

export function matchesEngHiringVacancy(vacancy: EngHiringVacancy, config: EngHiringSearchConfig): boolean {
  const sources = config.sources?.length ? config.sources : ENG_HIRING_SOURCES;
  if (!sources.includes(vacancy.source)) return false;

  const roleRegex = buildRolesRegex(config.text);
  const roleHaystack = `${vacancy.vacancy_title} ${vacancy.vacancy_description ?? ''}`;
  if (!roleRegex.test(roleHaystack)) return false;

  if (config.countries?.length) {
    const wanted = new Set(config.countries.map((c) => c.toLowerCase()));
    const countryCode = vacancy.country_code?.toLowerCase() ?? '';
    if (countryCode && !wanted.has(countryCode)) return false;
    const countryRegex = buildCountryRegex(config.countries);
    const haystack = `${vacancy.location ?? ''} ${vacancy.country ?? ''} ${countryCode}`.trim();
    if (!countryCode && !(countryRegex && countryRegex.test(haystack))) return false;
  }

  const days = Number(config.posted_within_days ?? 0);
  if (Number.isFinite(days) && days > 0) {
    if (!vacancy.published_at) return false;
    const now = config.now ? new Date(config.now) : new Date();
    const published = new Date(vacancy.published_at);
    if (Number.isNaN(now.getTime()) || Number.isNaN(published.getTime())) return false;
    const cutoff = new Date(now.getTime() - days * 86_400_000);
    if (published < cutoff) return false;
  }

  return true;
}

export function dedupeEngHiringVacancies(vacancies: EngHiringVacancy[]): EngHiringVacancy[] {
  const seen = new Set<string>();
  const out: EngHiringVacancy[] = [];
  for (const vacancy of vacancies) {
    const key = `${vacancy.source}:${vacancy.source_job_id || vacancy.vacancy_url}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(vacancy);
  }
  return out;
}

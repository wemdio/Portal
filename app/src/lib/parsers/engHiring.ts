import {
  careersUrl,
  companyDedupKey,
  domainFromJobUrls,
  normalizeJob,
} from '@/lib/jobs/atsCompanyParser';
import { ATS_COUNTRIES, buildCountryRegex, buildRolesRegex } from '@/lib/parsers/atsFilters';

export type EngHiringSource = 'greenhouse' | 'lever' | 'ashby' | 'workable' | 'bamboohr' | 'recruitee' | 'breezy' | 'workday' | 'smartrecruiters' | 'teamtailor';

export const ENG_HIRING_SOURCES: EngHiringSource[] = ['greenhouse', 'lever', 'ashby', 'workable', 'bamboohr', 'recruitee', 'breezy', 'workday', 'smartrecruiters', 'teamtailor'];
export const DEFAULT_ENG_HIRING_COMPANIES_LIMIT = 1000;
export const DEFAULT_ENG_HIRING_MAX_COVERAGE_LIMIT = 25000;

export function resolveEngHiringCompaniesLimit(
  value: unknown,
  options: { defaultLimit?: number; maxCoverageLimit?: number } = {},
): number {
  const defaultLimit = Math.max(1, Math.trunc(options.defaultLimit ?? DEFAULT_ENG_HIRING_COMPANIES_LIMIT));
  const maxCoverageLimit = Math.max(defaultLimit, Math.trunc(options.maxCoverageLimit ?? DEFAULT_ENG_HIRING_MAX_COVERAGE_LIMIT));
  const parsed = Number(value ?? defaultLimit);
  if (!Number.isFinite(parsed)) return defaultLimit;
  if (parsed <= 0) return maxCoverageLimit;
  return Math.min(maxCoverageLimit, Math.max(1, Math.trunc(parsed)));
}

export interface EngHiringSearchConfig {
  text?: string;
  sources?: EngHiringSource[];
  countries?: string[];
  posted_within_days?: number;
  /** 0 means maximum known-board coverage, capped by the server safety limit. */
  companies_limit?: number;
  max_results?: number;
  cache_max_age_hours?: number;
  refresh_cache?: boolean;
  enrich?: boolean;
  /** Default true: output one best matching vacancy row per company. */
  dedupe_companies?: boolean;
  /** Include open ATS jobs when the source does not expose a posting date. */
  include_unknown_dates?: boolean;
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
  sourceUrl?: string;
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

const MAX_DB_INTEGER = 2_147_483_647;
const MIN_ANNUAL_SALARY = 20_000;
const MAX_ANNUAL_SALARY = 500_000;

const B2B_TITLE_STRONG_RE =
  /\b(account executive|\bae\b|account manager|account director|business development(?: representative| manager| director| lead)?|sales development(?: representative| manager| lead)?|revenue development(?: representative| manager| lead)?|sales representative|sales consultant|sales manager|sales director|sales executive|sales lead|enterprise sales|commercial account|commercial account executive|commercial account director|commercial relationship manager|client partner|channel sales|partnerships? manager|partnerships? director|partnership sales|partner sales|partner manager|(?:manager|director|vp|head|lead),?\s+(?:of\s+)?partnerships?|\bsdr\b|\bbdr\b|\brdr\b|go[-\s]?to[-\s]?market|\bgtm\b)\b/i;

const B2B_TITLE_EXCLUDE_RE =
  /\b(psychiatrist|nurse|physician|clinical|therapist|engineer|engineering|developer|designer|product manager|program manager|project manager|field marketing|marketing event|content|community|people|hr|recruit|talent acquisition|finance|accounting|legal|operations|data scientist|security|customer support|technical support|teacher|warehouse|manufacturing|tax|audit|compliance|analyst|scrum master|assistant|administrator)\b/i;

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
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value.replace(/[^\d.]/g, ''))
      : NaN;
  if (!Number.isFinite(parsed)) return null;
  const rounded = Math.round(parsed);
  if (rounded <= 0 || rounded > MAX_DB_INTEGER) return null;
  return rounded;
}

function salaryNumberValue(value: unknown): number | null {
  const rounded = numberValue(value);
  if (rounded == null) return null;
  if (rounded < MIN_ANNUAL_SALARY || rounded > MAX_ANNUAL_SALARY) return null;
  return rounded;
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
    const value = salaryNumberValue(record[key]);
    if (value != null) return value;
  }
  return null;
}

function parseSalaryString(value: string): { from: number | null; to: number | null; currency: string | null } {
  const text = value
    .replace(/&mdash;|&ndash;|â€”|â€“|—|–/g, ' - ')
    .replace(/\bto\b/gi, ' - ')
    .trim();
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
    .filter((n): n is number => n != null && n >= MIN_ANNUAL_SALARY && n <= MAX_ANNUAL_SALARY);
  if (nums.length === 0) return { from: null, to: null, currency: null };
  if (nums.length === 1) return { from: nums[0], to: null, currency };
  const pairs = nums.slice(0, -1).map((from, index) => {
    const to = nums[index + 1];
    const low = Math.min(from, to);
    const high = Math.max(from, to);
    return { low, high, spread: high - low, index };
  });
  pairs.sort((a, b) => a.spread - b.spread || a.index - b.index);
  const best = pairs[0];
  return { from: best.low, to: best.high, currency };
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
    record.content_html,
    record.job_description,
    record.jobDescription,
    record.highlight,
    record.requirements,
    extractNestedString(record, ['_jobposting', 'description']),
    extractNestedString(record, ['details', 'description']),
    extractNestedString(record, ['opening', 'description']),
    extractNestedString(record, ['result', 'jobOpening', 'description']),
    extractNestedString(record, ['jobAd', 'sections', 'jobDescription', 'text']),
    extractNestedString(record, ['jobAd', 'sections', 'qualifications', 'text']),
  ];

  for (const candidate of candidates) {
    const text = cleanHtml(candidate);
    if (text) return text;
  }
  return null;
}

function compactText(value: string, maxLength = 420): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  const clipped = text.slice(0, maxLength);
  const sentenceEnd = Math.max(clipped.lastIndexOf('. '), clipped.lastIndexOf('! '), clipped.lastIndexOf('? '));
  return `${clipped.slice(0, sentenceEnd > 120 ? sentenceEnd + 1 : maxLength).trim()}...`;
}

function stripCompanyIntroHeading(text: string, companyName?: string): string {
  const escapedCompany = String(companyName ?? '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const companyHeading = escapedCompany ? `about\\s+${escapedCompany}` : "about\\s+[a-z0-9& .\\-']+";
  return text
    .replace(new RegExp(`^(?:${companyHeading}|who we are|about us|company overview)\\s*[:\\-]?\\s*`, 'i'), '')
    .trim();
}

function extractCompanyIntroFromDescription(description: string | null, companyName?: string): string | null {
  if (!description) return null;
  const withoutHeading = stripCompanyIntroHeading(description, companyName);
  const boundary = withoutHeading.search(
    /\b(role overview|what you(?:'|')?ll do|about the job|about the team|the role|responsibilities|key responsibilities|who you are|requirements|qualifications|benefits|compensation)\b/i,
  );
  const intro = boundary >= 80 ? withoutHeading.slice(0, boundary) : withoutHeading;
  const compact = compactText(stripCompanyIntroHeading(intro, companyName));
  return compact.length >= 40 ? compact : null;
}

function extractCompanyDescription(raw: unknown, vacancyDescription: string | null, companyName?: string): string | null {
  const record = asRecord(raw);
  if (record) {
    const candidates = [
      record.company_description,
      record.companyDescription,
      record.company_summary,
      record.companySummary,
      extractNestedString(record, ['company', 'description']),
      extractNestedString(record, ['organization', 'description']),
      extractNestedString(record, ['department', 'description']),
      extractNestedString(record, ['jobAd', 'sections', 'companyDescription', 'text']),
    ];
    for (const candidate of candidates) {
      const text = compactText(cleanPlainText(candidate));
      if (text.length >= 40) return text;
    }
  }

  return extractCompanyIntroFromDescription(vacancyDescription, companyName);
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
    if (from != null || to != null) return { from, to, currency };
  }

  const directFrom = firstNumber(record, ['salary_min', 'salaryMin', 'min_salary', 'minSalary']);
  const directTo = firstNumber(record, ['salary_max', 'salaryMax', 'max_salary', 'maxSalary']);
  const directCurrency = firstString(record, ['salary_currency', 'salaryCurrency', 'currency']).toUpperCase() || null;
  if (directFrom != null || directTo != null) {
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

function isB2BRoleSearch(text?: string | null): boolean {
  return /\bb2b\b/i.test(text ?? '');
}

export function isHighIntentB2BSalesTitle(title: string): boolean {
  const cleanTitle = cleanPlainText(title);
  if (!B2B_TITLE_STRONG_RE.test(cleanTitle)) return false;
  if (B2B_TITLE_EXCLUDE_RE.test(cleanTitle)) return false;
  return true;
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
  const companyDescription = extractCompanyDescription(raw, description, normalized.company);
  const salary = extractSalary(raw);

  return {
    source,
    source_company_slug: normalized.slug || ctx.slug || '',
    source_job_id: sourceJobId,
    company_name: normalized.company,
    company_site_url: domain ? `https://${domain}` : null,
    company_description: companyDescription,
    vacancy_title: normalized.title,
    vacancy_description: description,
    vacancy_url: normalized.url,
    careers_url: normalized.slug ? careersUrl(source, normalized.slug, ctx.sourceUrl) : null,
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
  const companyDescription = extractCompanyDescription(detailRaw, description, vacancy.company_name);
  const salary = extractSalary(detailRaw);
  const domain = domainFromJobUrls([vacancy.vacancy_url, firstString(asRecord(detailRaw) ?? {}, ['absolute_url', 'hostedUrl', 'jobUrl'])]);

  return {
    ...vacancy,
    company_site_url: vacancy.company_site_url ?? (domain ? `https://${domain}` : null),
    company_description: vacancy.company_description ?? companyDescription,
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

  if (isB2BRoleSearch(config.text)) {
    if (!isHighIntentB2BSalesTitle(vacancy.vacancy_title)) return false;
  } else {
    const roleRegex = buildRolesRegex(config.text);
    const roleHaystack = `${vacancy.vacancy_title} ${vacancy.vacancy_description ?? ''}`;
    if (!roleRegex.test(roleHaystack)) return false;
  }

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
    if (!vacancy.published_at) return config.include_unknown_dates === true;
    const now = config.now ? new Date(config.now) : new Date();
    const published = new Date(vacancy.published_at);
    if (Number.isNaN(now.getTime()) || Number.isNaN(published.getTime())) return false;
    const cutoff = new Date(now.getTime() - days * 86_400_000);
    if (published < cutoff) return false;
  }

  return true;
}

function parsedTime(value: string | null | undefined): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function scoreEngHiringVacancy(vacancy: EngHiringVacancy, config: Pick<EngHiringSearchConfig, 'text'> = {}): number {
  let score = 0;
  const title = vacancy.vacancy_title;
  if (isB2BRoleSearch(config.text)) {
    if (isHighIntentB2BSalesTitle(title)) score += 1000;
  } else {
    const roleRegex = buildRolesRegex(config.text);
    if (roleRegex.test(title)) score += 500;
    if (vacancy.vacancy_description && roleRegex.test(vacancy.vacancy_description)) score += 100;
  }
  if (vacancy.salary_from != null || vacancy.salary_to != null) score += 40;
  if (vacancy.salary_from != null && vacancy.salary_to != null) score += 10;
  if (vacancy.company_site_url) score += 20;
  if (vacancy.company_description) score += 15;
  if (vacancy.vacancy_description) score += 10;
  score += Math.min(9, Math.floor(parsedTime(vacancy.published_at) / 100_000_000_000));
  return score;
}

function engHiringCompanyKey(vacancy: EngHiringVacancy): string {
  const companyKey = companyDedupKey(vacancy.company_name);
  if (companyKey) return companyKey;
  const slugKey = `${vacancy.source}:${vacancy.source_company_slug}`.toLowerCase();
  return slugKey || `${vacancy.source}:${vacancy.source_job_id}`.toLowerCase();
}

export function dedupeEngHiringVacanciesByCompany<T extends EngHiringVacancy>(
  vacancies: T[],
  config: Pick<EngHiringSearchConfig, 'text'> = {},
): T[] {
  const byCompany = new Map<string, T>();
  for (const vacancy of vacancies) {
    const key = engHiringCompanyKey(vacancy);
    const existing = byCompany.get(key);
    if (!existing || scoreEngHiringVacancy(vacancy, config) > scoreEngHiringVacancy(existing, config)) {
      byCompany.set(key, vacancy);
    }
  }

  return [...byCompany.values()].sort((a, b) => {
    const scoreDelta = scoreEngHiringVacancy(b, config) - scoreEngHiringVacancy(a, config);
    if (scoreDelta !== 0) return scoreDelta;
    return parsedTime(b.published_at) - parsedTime(a.published_at);
  });
}

export function dedupeEngHiringVacancies(vacancies: EngHiringVacancy[]): EngHiringVacancy[] {
  return dedupeEngHiringRowsBySourceJobId(vacancies);
}

export function dedupeEngHiringRowsBySourceJobId<T extends { source: EngHiringSource; source_job_id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const key = `${row.source}:${row.source_job_id}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

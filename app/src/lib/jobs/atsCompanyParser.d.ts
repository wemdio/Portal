// Type declarations for the plain-JS atsCompanyParser.js so TypeScript consumers
// (the worker runner) get types. Runtime stays the .js module (also used by the
// CLI .mjs and the jest test).

export interface AtsCompanyToken {
  name: string;
  slug: string;
  url: string;
}

export interface AtsNormalizedJob {
  ats: string;
  slug: string;
  company: string;
  company_key: string;
  title: string;
  location: string;
  country: string;
  url: string;
  posted_at: string;
  roles: string[];
}

export interface AtsLead {
  company: string;
  domain: string;
  ats: string;
  slug: string;
  country: string;
  cities: string[];
  roles_found: string[];
  job_count: number;
  job_titles: string[];
  job_urls: string[];
  careers_url: string;
  latest_posted_at: string;
}

export const SUPPORTED_ATS: string[];
export const CSV_HEADERS: string[];

export function postingsUrl(ats: string, slug: string): string;
export function careersUrl(ats: string, slug: string): string;
export function extractJobs(ats: string, payload: unknown): unknown[];
export function normalizeJob(
  ats: string,
  job: unknown,
  ctx?: { slug?: string; companyName?: string },
): AtsNormalizedJob | null;
export function normalizeGreenhouseJob(job: unknown, ctx?: { slug?: string; companyName?: string }): AtsNormalizedJob | null;
export function normalizeLeverJob(job: unknown, ctx?: { slug?: string; companyName?: string }): AtsNormalizedJob | null;
export function normalizeAshbyJob(job: unknown, ctx?: { slug?: string; companyName?: string }): AtsNormalizedJob | null;
export function normalizeWorkableJob(job: unknown, ctx?: { slug?: string; companyName?: string }): AtsNormalizedJob | null;
export function normalizeBamboohrJob(job: unknown, ctx?: { slug?: string; companyName?: string }): AtsNormalizedJob | null;
export function normalizeRecruiteeJob(job: unknown, ctx?: { slug?: string; companyName?: string }): AtsNormalizedJob | null;
export function parseCompanyCsv(text: string): AtsCompanyToken[];
export function buildCompanyLeads(jobs: AtsNormalizedJob[]): AtsLead[];
export function domainFromJobUrls(jobUrls: string[]): string;
export function pickDomainFromSuggestions(
  name: string,
  suggestions: Array<{ name?: string; domain?: string }>,
): string;
export function companyDedupKey(value: string): string;
export function normalizeCompanyName(value: string): string;
export function roleTagsForTitle(title: string): string[];
export function exportCompanyLeadsToCsv(leads: AtsLead[]): string;

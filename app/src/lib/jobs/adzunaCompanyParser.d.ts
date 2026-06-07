// Type declarations for the plain-JS adzunaCompanyParser.js (worker/runner use).

export interface AdzunaNormalizedJob {
  id: string;
  company: string;
  company_key: string;
  title: string;
  country: string;
  city: string;
  url: string;
  query: string;
  posted_at: string;
  roles: string[];
  source: string;
}

export interface AdzunaLead {
  company: string;
  country: string;
  cities: string[];
  roles_found: string[];
  job_count: number;
  job_titles: string[];
  job_urls: string[];
  queries: string[];
  latest_posted_at: string;
  source: string;
  /** Filled by the runner after enrichment. */
  domain?: string;
}

export const CSV_HEADERS: string[];
export function normalizeAdzunaJob(
  job: unknown,
  options?: { country?: string; query?: string },
): AdzunaNormalizedJob | null;
export function buildCompanyLeads(jobs: AdzunaNormalizedJob[]): AdzunaLead[];
export function companyDedupKey(value: string): string;
export function normalizeCompanyName(value: string): string;
export function roleTagsForTitle(title: string): string[];
export function exportCompanyLeadsToCsv(leads: AdzunaLead[]): string;

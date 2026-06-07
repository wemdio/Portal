export type ParserJobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface ParserJob {
  id: string;
  user_id: string;
  parser_type: 'hh_vacancies';
  status: ParserJobStatus;
  config: HHSearchConfig;
  total_found?: number | null;
  total_parsed?: number | null;
  progress_percent?: number | null;
  progress_stage?: string | null;
  progress_detail?: PartitionProgressDetail | null;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  error_message?: string | null;
}

export interface PartitionProgressDetail {
  total_subqueries: number;
  completed_subqueries: number;
  subquery_labels?: string[];
  current_subquery?: string | null;
}

export interface HHSearchConfig {
  text: string;
  area?: string | string[];
  salary_from?: number;
  currency?: string;
  date_from?: string;
  date_to?: string;
  per_page?: number;
  params?: Record<string, string | string[]>;
  /** Regional subdomain extracted from URL, e.g. "spb" from spb.hh.ru */
  subdomain?: string;
  /**
   * Fetch employer details (site/description/industries).
   * When false, parsing is significantly faster.
   */
  fetch_employers?: boolean;
}

export interface SearchParserJob {
  id: string;
  user_id: string;
  status: ParserJobStatus;
  config: { queries?: string[]; brief?: string; user_query?: string; search_depth?: number };
  total_queries: number;
  processed_queries: number;
  total_results: number;
  progress_percent?: number | null;
  progress_stage?: string | null;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  error_message?: string | null;
}

export interface SearchResult {
  id: string;
  job_id: string;
  query: string;
  title: string;
  link: string;
  snippet: string;
  position: number;
  company_name?: string | null;
  site?: string | null;
  description?: string | null;
  email?: string | null;
  provider?: string | null;
  created_at: string;
}

export interface SearchQueryStat {
  id: string;
  job_id: string;
  query: string;
  query_index: number;
  provider: string | null;
  last_google_page: number | null;
  results_count: number;
  created_at: string;
}

export interface YandexMapsJob {
  id: string;
  user_id: string;
  status: ParserJobStatus;
  config: { search_urls: string[]; max_results?: number; headless?: boolean };
  progress_stage?: string | null;
  total_links: number;
  processed_links: number;
  total_organizations: number;
  processed_organizations: number;
  proxy_enabled: boolean;
  proxy_protocol?: string | null;
  proxy_host?: string | null;
  proxy_port?: string | null;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  error_message?: string | null;
}

export interface YandexMapsLinkRow {
  id: string;
  job_id: string;
  link: string;
  created_at: string;
}

export interface YandexMapsOrganizationRow {
  id: string;
  job_id: string;
  name?: string | null;
  country?: string | null;
  city?: string | null;
  address?: string | null;
  rating?: string | null;
  reviews_count?: string | null;
  website?: string | null;
  email?: string | null;
  phone?: string | null;
  telegram?: string | null;
  vk?: string | null;
  instagram?: string | null;
  whatsapp?: string | null;
  card_url?: string | null;
  working_hours?: string | null;
  categories?: string | null;
  created_at: string;
}

export interface HHVacancyRow {
  id: string;
  job_id: string;
  vacancy_id: string;
  name: string;
  url: string;
  salary_from?: number | null;
  salary_to?: number | null;
  salary_currency?: string | null;
  company_name: string;
  company_url?: string | null;
  company_site_url?: string | null;
  company_description?: string | null;
  area: string;
  industries: string[];
  published_at?: string | null;
  created_at: string;
}

// ── ATS parser (Greenhouse / Lever / Ashby) ──

export type AtsType = 'greenhouse' | 'lever' | 'ashby';

export interface AtsSearchConfig {
  /** Role keywords (comma-separated); also shown as the jobs-list label. */
  text: string;
  ats: AtsType[];
  /** Country codes from lib/parsers/atsFilters (empty/undefined = any country). */
  countries?: string[];
  /** Keep only postings newer than this many days (0/undefined = any). */
  posted_within_days?: number;
  /** Companies scanned per ATS (0 = all; capped server-side). */
  companies_limit?: number;
  /** Resolve company domains via enrichment (default true). */
  enrich?: boolean;
}

export interface AtsParserJob {
  id: string;
  user_id: string;
  parser_type: 'ats_companies';
  status: ParserJobStatus;
  config: AtsSearchConfig;
  total_found?: number | null;
  total_parsed?: number | null;
  progress_percent?: number | null;
  progress_stage?: string | null;
  progress_detail?: PartitionProgressDetail | null;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  error_message?: string | null;
}

export interface AtsCompanyRow {
  id: string;
  job_id: string;
  company: string;
  domain?: string | null;
  ats: string;
  slug: string;
  country?: string | null;
  cities: string[];
  roles_found: string[];
  job_count: number;
  job_titles: string[];
  job_urls: string[];
  careers_url?: string | null;
  latest_posted_at?: string | null;
  created_at: string;
}


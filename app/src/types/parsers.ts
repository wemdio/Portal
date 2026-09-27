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
  strict_title_match?: boolean;
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
  config: {
    search_urls?: string[];
    catalog_filters?: { cities?: string[]; categories?: string[]; countries?: string[] } | null;
    max_results?: number;
    headless?: boolean;
  };
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
  employer_id?: string | null;
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

// ── ENG hiring parser (first-party ATS vacancies) ──

export type EngHiringSource = 'greenhouse' | 'lever' | 'ashby' | 'workable' | 'bamboohr' | 'recruitee' | 'breezy' | 'workday' | 'smartrecruiters' | 'teamtailor' | 'jobhive';

export interface EngHiringSearchConfig {
  /** Role keywords, comma-separated. Matched against vacancy title. */
  text: string;
  sources: EngHiringSource[];
  /** Country codes from lib/parsers/atsFilters (empty/undefined = any country). */
  countries?: string[];
  /** Keep only postings newer than this many days (0/undefined = any). */
  posted_within_days?: number;
  /** Companies scanned per source (0 = maximum known-board coverage, capped server-side). */
  companies_limit?: number;
  /** Result cap after filtering. */
  max_results?: number;
  /** Reuse cache if it is fresh enough. */
  cache_max_age_hours?: number;
  /** Refresh first-party ATS cache before filtering. */
  refresh_cache?: boolean;
  /** Resolve missing company domains by company name. */
  enrich?: boolean;
  /** Default true: output one best matching vacancy row per company. */
  dedupe_companies?: boolean;
  /** Include open ATS jobs when the source does not expose a posting date. */
  include_unknown_dates?: boolean;
}

export interface EngHiringParserJob {
  id: string;
  user_id: string;
  parser_type: 'eng_hiring';
  status: ParserJobStatus;
  config: EngHiringSearchConfig;
  total_found?: number | null;
  total_parsed?: number | null;
  progress_percent?: number | null;
  progress_stage?: string | null;
  progress_detail?: PartitionProgressDetail | Record<string, unknown> | null;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  error_message?: string | null;
}

export interface EngHiringVacancyRow {
  id: string;
  job_id: string;
  cache_id?: string | null;
  source: EngHiringSource;
  source_company_slug: string;
  source_job_id: string;
  company_name: string;
  company_site_url?: string | null;
  company_description?: string | null;
  vacancy_title: string;
  vacancy_description?: string | null;
  vacancy_url: string;
  careers_url?: string | null;
  location?: string | null;
  city?: string | null;
  country?: string | null;
  country_code?: string | null;
  salary_from?: number | null;
  salary_to?: number | null;
  salary_currency?: string | null;
  published_at?: string | null;
  created_at: string;
}

// ── Polza ENG outreach (v2: trigger router CEO, 23.09.2026) ──

export interface PolzaOutreachConfig {
  countries: string[];
  posted_within_days: number;
  limit: number;
  sources?: Array<'hiring' | 'yc'>;
  yc_batch_from_year?: number;
  min_employees?: number;
  max_employees?: number;
  write_threshold?: number;
  /** Лимит на ИИ за запуск, $ (1–100); у запусков до 26.09.2026 его нет. */
  llm_budget_usd?: number;
  /** Брать и компании, уже готовые в прошлых запусках (по умолчанию нет). */
  include_previously_exported?: boolean;
}

export interface PolzaOutreachParserJob {
  id: string;
  user_id: string;
  parser_type: 'polza_outreach';
  status: ParserJobStatus;
  config: PolzaOutreachConfig;
  total_found?: number | null;
  total_parsed?: number | null;
  progress_percent?: number | null;
  progress_stage?: string | null;
  progress_detail?: PartitionProgressDetail | Record<string, unknown> | null;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  error_message?: string | null;
}

export interface PolzaOutreachLetter {
  n: number;
  subject: string;
  body: string;
}

export interface PolzaOutreachCompanyRow {
  id: string;
  job_id: string;
  source_type: string;
  vacancy_id?: string | null;
  job_title?: string | null;
  job_source_url?: string | null;
  job_country_code?: string | null;
  job_published_at?: string | null;
  company_name: string;
  normalized_domain?: string | null;
  company_website?: string | null;
  outbound_mandate?: boolean | null;
  outbound_evidence?: string | null;
  service_line?: string | null;
  target_sales_geo?: string | null;
  target_sales_geo_evidence?: string | null;
  target_sales_geo_confidence?: 'high' | 'medium' | 'low' | null;
  selected_company_email?: string | null;
  email_type?: string | null;
  email_source_url?: string | null;
  /** Вердикт SMTP-проверки адреса: ok / catch_all / unverified; у строк до 26.09.2026 — null. */
  email_verification?: string | null;
  sequence_id?: string | null;
  letters?: PolzaOutreachLetter[] | null;
  /** Шаблон цепочки оффера, по которому собраны письма (с 26.09.2026). */
  chain_template_id?: string | null;
  status: string;
  stage?: string | null;
  exclusion_reason?: string | null;
  review_reason?: string | null;
  source_list?: string[] | null;
  trigger_list?: Array<{ type: string; title: string; url: string | null; date: string | null; quote: string | null }> | null;
  primary_trigger?: string | null;
  trigger_evidence_url?: string | null;
  trigger_phrase?: string | null;
  company_context?: string | null;
  likely_gtm_problem?: string | null;
  outreach_angle?: string | null;
  segments?: string[] | null;
  employee_range?: string | null;
  industry?: string | null;
  country?: string | null;
  lead_score?: number | null;
  score_breakdown?: Record<string, number> | null;
  lead_status?: 'write_now' | 'skip' | null;
  recommended_case?: string | null;
  case_reason?: string | null;
  case_snippet?: string | null;
  created_at: string;
}

/**
 * Воронка английского аутрича; правила и порядок этапов — lib/polzaOutreach/funnel.ts
 * (с 26.09.2026 почта идёт до Lead Score). geo_confirmed — исторический ключ «write now».
 */
export interface PolzaOutreachFunnel {
  vacancies: number;
  domain_found: number;
  icp_passed: number;
  geo_confirmed: number;
  email_found: number;
  ready: number;
}



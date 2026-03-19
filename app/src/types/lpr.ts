export type LprJobStatus = 'pending' | 'running' | 'completed' | 'failed';

export type LprSeniority =
  | 'owner'
  | 'founder'
  | 'c_suite'
  | 'partner'
  | 'vp'
  | 'head'
  | 'director'
  | 'manager'
  | 'senior';

export type LprFunction =
  | 'sales'
  | 'marketing'
  | 'finance'
  | 'operations'
  | 'engineering'
  | 'hr'
  | 'procurement'
  | 'it'
  | 'legal'
  | 'executive';

export type LprProvider = 'cis';

export interface CompanyInput {
  domain?: string;
  company_name?: string;
  linkedin_url?: string;
  /**
   * Optional country/geo hint for CIS discovery, e.g. 'RU', 'KZ', 'BY'.
   */
  country_code?: string;
}

export interface LprSearchConfig {
  company: CompanyInput;
  seniorities?: LprSeniority[];
  functions?: LprFunction[];
  max_candidates?: number;
  max_enrichments?: number;
  /**
   * Which backend provider to use for discovery.
   * - 'cis' enables CIS-native discovery (Yandex/2GIS/etc.).
   */
  provider?: LprProvider;
}

/** Unified candidate after mapping + scoring. */
export interface ContactCandidate {
  id?: string;
  job_id: string;

  full_name: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  seniority: string | null;
  function_area: string | null;

  company_name: string | null;
  company_domain: string | null;

  work_email: string | null;
  personal_email: string | null;
  phone: string | null;
  linkedin_url: string | null;

  score: number;
  data_freshness: string | null;

  created_at?: string;
}

export interface LprJob {
  id: string;
  user_id: string;
  status: LprJobStatus;
  config: LprSearchConfig;
  total_found: number;
  enriched_count: number;
  usable_count: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
}

export interface LprSearchResponse {
  job_id: string;
  status: LprJobStatus;
  candidates: ContactCandidate[];
  total_found: number;
  enriched_count: number;
  usable_count: number;
}

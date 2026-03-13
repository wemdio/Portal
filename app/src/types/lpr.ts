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

export type LprProvider = 'apollo_pdl' | 'cis';

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
   * - 'apollo_pdl' (default) keeps existing global behaviour.
   * - 'cis' enables CIS-native discovery (Yandex/2GIS/etc.).
   */
  provider?: LprProvider;
}

/** Raw person from Apollo People Search (no emails/phones). */
export interface ApolloPersonRaw {
  apollo_id: string;
  first_name: string;
  last_name_obfuscated: string;
  title: string | null;
  organization_name: string | null;
  last_refreshed_at: string | null;
  has_email: boolean;
  has_direct_phone: string | null;
}

/** Enriched person from PDL. */
export interface PdlPersonEnriched {
  pdl_id: string;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  job_title: string | null;
  job_title_role: string | null;
  job_title_levels: string[] | null;
  job_company_name: string | null;
  job_company_website: string | null;
  linkedin_url: string | null;
  work_email: string | null;
  personal_emails: string[];
  phone_numbers: string[];
  location_name: string | null;
  likelihood: number;
}

/** Unified candidate after mapping + scoring. */
export interface ContactCandidate {
  id?: string;
  job_id: string;

  apollo_id: string | null;
  pdl_id: string | null;

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
  enrichment_source: 'apollo' | 'pdl' | 'both' | 'none';
  pdl_likelihood: number | null;
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
  apollo_credits_used: number;
  pdl_credits_used: number;
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

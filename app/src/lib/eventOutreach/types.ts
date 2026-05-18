/** Type definitions for the event-agency outreach tool. */

/** Signal codes detected for a company. */
export type EventSignal =
  | 'anniversary'
  | 'seeking_event_manager'
  | 'large_company'
  | 'mid_company';

export type EventTier = 'hot' | 'warm' | 'cold';

export type EmailSource = 'scraped' | 'registry' | 'none';

/** One example hook the agency provided as a style reference. */
export interface HookExample {
  signal: string;
  hook: string;
}

/** Agency profile used to ground the LLM hook generation. */
export interface AgencyConfig {
  agency_name: string;
  agency_services: string[];
  agency_tone: string;
  hook_examples: HookExample[];
  /** Industry name -> pain point sentence. */
  industry_pain_points: Record<string, string>;
}

/** A raw company row pulled from companies_directory. */
export interface DirectoryCompany {
  id: number;
  name: string;
  inn: string | null;
  kpp: string | null;
  ogrn: string | null;
  address: string | null;
  region_code: string | null;
  okved_code: string | null;
  activity_type: string | null;
  employees_count: number | null;
  revenue: number | null;
  website: string | null;
  email: string | null;
  phones: string | null;
}

/** Result of running signal detection on one company. */
export interface DetectedSignals {
  company_age: number | null;
  is_anniversary: boolean;
  anniversary_year: number | null;
  hh_vacancies_count: number;
  seeking_event_manager: boolean;
  detected_signals: EventSignal[];
  tier: EventTier;
}

/** Filters supplied to the SQL pre-filter step. */
export interface SelectFilters {
  regionCodes?: string[];
  okvedPrefixes?: string[];
  minEmployees?: number;
  limit: number;
}

/** A finished lead row as stored in event_outreach_leads. */
export interface EventLead {
  id: string;
  batch_date: string;
  company_name: string;
  inn: string | null;
  kpp: string | null;
  ogrn: string | null;
  address: string | null;
  region_code: string | null;
  okved_code: string | null;
  activity_type: string | null;
  industry: string | null;
  employees_count: number | null;
  revenue: number | null;
  website: string | null;
  email: string | null;
  email_source: EmailSource;
  company_age: number | null;
  is_anniversary: boolean;
  anniversary_year: number | null;
  hh_vacancies_count: number;
  seeking_event_manager: boolean;
  detected_signals: EventSignal[];
  tier: EventTier;
  hook: string | null;
  subject_line: string | null;
  created_at: string;
}

export interface CollectResult {
  selected: number;
  inserted: number;
  hot: number;
  warm: number;
  cold: number;
  emailsFound: number;
  hooksGenerated: number;
  hhEmployers: number;
  errors: string[];
}

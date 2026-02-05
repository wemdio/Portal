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
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  error_message?: string | null;
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


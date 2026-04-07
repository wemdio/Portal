export interface RawSignalItem {
  title: string;
  description: string;
  url: string;
  source: 'vc_ru' | 'hh_ru' | 'rbc' | 'kommersant' | 'habr';
  publishedAt?: string;
  /** HH.ru employer metadata (pre-structured, bypasses LLM for basic fields) */
  hh?: {
    employer_id: string;
    company_name: string;
    company_site_url?: string;
    area?: string;
    vacancy_name: string;
    industries?: string[];
  };
}

export interface EnrichedLead {
  company_name: string;
  website: string | null;
  city: string | null;
  employee_count: string | null;
  description: string;
  niche: string;
  signal_type: string;
  signal_detail: string;
  intent_score: number;
  priority: 'RED_HOT' | 'HOT' | 'WARM';
  outreach_angle: string;
  source_url: string;
  hh_employer_id: string | null;
  hh_vacancy_name: string | null;
}

export interface NashLead extends EnrichedLead {
  id: string;
  batch_date: string;
  inn: string | null;
  smtp_status: 'pending' | 'valid' | 'invalid' | 'catch_all' | 'unknown' | 'skipped';
  smtp_tier: number | null;
  emails_found: string[];
  emails_validated: string[];
  email_sequence: EmailStep[] | null;
  instantly_uploaded: boolean;
  instantly_lead_id: string | null;
  raw_data: Record<string, unknown> | null;
  created_at: string;
}

export interface EmailStep {
  subject: string;
  body: string;
}

export interface SenderConfig {
  sender_name: string;
  sender_calendly: string;
  sender_website: string;
  auto_upload_enabled: boolean;
}

export interface CollectResult {
  collected: number;
  enriched: number;
  inserted: number;
  skippedDuplicates: number;
  emailsFound: number;
  emailsValidated: number;
  errors: string[];
}

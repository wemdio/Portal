export interface RawNewsItem {
  title: string;
  description: string;
  url: string;
  source: 'google_news' | 'techcrunch' | 'hackernews' | 'yc_directory';
  publishedAt?: string;
}

export interface EnrichedLead {
  company_name: string;
  website: string | null;
  founder_name: string | null;
  founder_linkedin: string | null;
  email_guess: string | null;
  description: string;
  niche: string;
  signal_type: string;
  signal_detail: string;
  intent_score: number;
  priority: 'RED_HOT' | 'HOT' | 'WARM';
  outreach_angle: string;
  timing: string;
  delay_days: number;
  region: 'US' | 'EU';
  source_url: string;
}

export interface BugorLead extends EnrichedLead {
  id: string;
  batch_date: string;
  send_after: string;
  smtp_status: 'pending' | 'valid' | 'invalid' | 'catch_all' | 'unknown' | 'skipped';
  smtp_tier: number | null;
  smtp_retry_count: number;
  smtp_last_attempt_at: string | null;
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
  emailsGenerated: number;
  instantlyUploaded: number;
  queuedForLater: number;
  drainedFromQueue: number;
  errors: string[];
}

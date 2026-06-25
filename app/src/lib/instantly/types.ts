// ─── Pagination ───────────────────────────────────────────────────────────────

export interface PaginationParams {
  limit?: number;
  starting_after?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  next_starting_after?: string;
}

// ─── Campaign ─────────────────────────────────────────────────────────────────

export const CampaignStatus = {
  Draft: 0,
  Active: 1,
  Paused: 2,
  Completed: 3,
  RunningSubsequences: 4,
  AccountSuspended: -99,
  AccountsUnhealthy: -1,
  BounceProtect: -2,
} as const;
export type CampaignStatusValue = (typeof CampaignStatus)[keyof typeof CampaignStatus];

export const CampaignStatusLabels: Record<number, string> = {
  [CampaignStatus.Draft]: 'Черновик',
  [CampaignStatus.Active]: 'Активна',
  [CampaignStatus.Paused]: 'На паузе',
  [CampaignStatus.Completed]: 'Завершена',
  [CampaignStatus.RunningSubsequences]: 'Подпоследовательности',
  [CampaignStatus.AccountSuspended]: 'Аккаунт заблокирован',
  [CampaignStatus.AccountsUnhealthy]: 'Аккаунты нездоровы',
  [CampaignStatus.BounceProtect]: 'Защита от bounce',
};

export interface CampaignScheduleTiming {
  from: string;
  to: string;
}

export interface CampaignScheduleDays {
  0?: boolean;
  1?: boolean;
  2?: boolean;
  3?: boolean;
  4?: boolean;
  5?: boolean;
  6?: boolean;
}

export interface CampaignScheduleEntry {
  name: string;
  timing: CampaignScheduleTiming;
  days: CampaignScheduleDays;
  timezone: string;
}

export interface CampaignSchedule {
  schedules: CampaignScheduleEntry[];
  start_date?: string | null;
  end_date?: string | null;
}

export interface SequenceStep {
  subject?: string;
  body?: string;
  type?: string;
  wait_days?: number;
  delay?: number;
  delay_unit?: 'minutes' | 'hours' | 'days' | string;
  variants?: SequenceVariant[];
}

export interface SequenceVariant {
  subject?: string;
  body?: string;
}

export interface CampaignSequence {
  steps: SequenceStep[];
}

export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatusValue;
  campaign_schedule: CampaignSchedule;
  sequences?: CampaignSequence[];
  email_list?: string[];
  email_tag_list?: string[];
  daily_limit?: number | null;
  daily_max_leads?: number | null;
  email_gap?: number | null;
  random_wait_max?: number | null;
  text_only?: boolean | null;
  first_email_text_only?: boolean | null;
  stop_on_reply?: boolean | null;
  stop_on_auto_reply?: boolean | null;
  stop_for_company?: boolean | null;
  link_tracking?: boolean | null;
  open_tracking?: boolean | null;
  prioritize_new_leads?: boolean | null;
  match_lead_esp?: boolean | null;
  is_evergreen?: boolean | null;
  pl_value?: number | null;
  insert_unsubscribe_header?: boolean | null;
  allow_risky_contacts?: boolean | null;
  disable_bounce_protect?: boolean | null;
  cc_list?: string[];
  bcc_list?: string[];
  not_sending_status?: number | null;
  organization?: string | null;
  owned_by?: string | null;
  timestamp_created?: string;
  timestamp_updated?: string;
}

export interface CampaignCreatePayload {
  name: string;
  campaign_schedule: CampaignSchedule;
  sequences?: CampaignSequence[];
  email_list?: string[];
  email_tag_list?: string[];
  daily_limit?: number;
  daily_max_leads?: number;
  email_gap?: number;
  random_wait_max?: number;
  text_only?: boolean;
  first_email_text_only?: boolean;
  stop_on_reply?: boolean;
  stop_on_auto_reply?: boolean;
  stop_for_company?: boolean;
  link_tracking?: boolean;
  open_tracking?: boolean;
  prioritize_new_leads?: boolean;
  match_lead_esp?: boolean;
  is_evergreen?: boolean;
  pl_value?: number;
  insert_unsubscribe_header?: boolean;
  allow_risky_contacts?: boolean;
  disable_bounce_protect?: boolean;
  cc_list?: string[];
  bcc_list?: string[];
}

export type CampaignUpdatePayload = Partial<CampaignCreatePayload>;

// ─── Account ──────────────────────────────────────────────────────────────────

export const AccountStatus = {
  Active: 1,
  Paused: 2,
  Maintenance: 3,
  ConnectionError: -1,
  SoftBounceError: -2,
  SendingError: -3,
} as const;
export type AccountStatusValue = (typeof AccountStatus)[keyof typeof AccountStatus];

export const AccountStatusLabels: Record<number, string> = {
  [AccountStatus.Active]: 'Активен',
  [AccountStatus.Paused]: 'На паузе',
  [AccountStatus.Maintenance]: 'Обслуживание',
  [AccountStatus.ConnectionError]: 'Ошибка подключения',
  [AccountStatus.SoftBounceError]: 'Soft bounce',
  [AccountStatus.SendingError]: 'Ошибка отправки',
};

export const WarmupStatus = {
  Paused: 0,
  Active: 1,
  Banned: -1,
  SpamFolderUnknown: -2,
  PermanentSuspension: -3,
} as const;
export type WarmupStatusValue = (typeof WarmupStatus)[keyof typeof WarmupStatus];

export const WarmupStatusLabels: Record<number, string> = {
  [WarmupStatus.Paused]: 'Пауза',
  [WarmupStatus.Active]: 'Активен',
  [WarmupStatus.Banned]: 'Бан',
  [WarmupStatus.SpamFolderUnknown]: 'Спам-папка',
  [WarmupStatus.PermanentSuspension]: 'Постоянная блокировка',
};

export const ProviderCode = {
  CustomIMAP: 1,
  Google: 2,
  Microsoft: 3,
  AWS: 4,
  AirMail: 8,
} as const;

export const ProviderLabels: Record<number, string> = {
  [ProviderCode.CustomIMAP]: 'Custom IMAP/SMTP',
  [ProviderCode.Google]: 'Google',
  [ProviderCode.Microsoft]: 'Microsoft',
  [ProviderCode.AWS]: 'AWS',
  [ProviderCode.AirMail]: 'AirMail',
};

export interface AccountWarmupConfig {
  limit?: number;
  advanced?: Record<string, unknown>;
  warmup_custom_ftag?: string;
  increment?: string;
  reply_rate?: number;
}

export interface AccountStatusMessage {
  code?: string;
  command?: string;
  response?: string;
  e_message?: string;
  responseCode?: number;
}

export interface Account {
  email: string;
  first_name: string;
  last_name: string;
  organization: string;
  provider_code: number;
  warmup_status: WarmupStatusValue;
  status: AccountStatusValue;
  setup_pending: boolean;
  is_managed_account: boolean;
  warmup?: AccountWarmupConfig;
  daily_limit?: number | null;
  tracking_domain_name?: string | null;
  tracking_domain_status?: string | null;
  enable_slow_ramp?: boolean | null;
  stat_warmup_score?: number | null;
  sending_gap?: number;
  signature?: string | null;
  status_message?: AccountStatusMessage;
  timestamp_created?: string;
  timestamp_updated?: string;
  timestamp_last_used?: string | null;
  timestamp_warmup_start?: string | null;
  warmup_pool_id?: string | null;
  added_by?: string | null;
  modified_by?: string | null;
}

// ─── Lead ─────────────────────────────────────────────────────────────────────

export interface Lead {
  id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  company_name?: string | null;
  title?: string | null;
  phone?: string | null;
  website?: string | null;
  linkedin_url?: string | null;
  campaign_id?: string | null;
  lead_list_id?: string | null;
  interest_status?: number;
  interest_value?: string | null;
  timestamp_created?: string;
  timestamp_updated?: string;
  custom_variables?: Record<string, string>;
}

export interface LeadCreatePayload {
  email: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  phone?: string;
  website?: string;
  linkedin_url?: string;
  campaign_id?: string;
  lead_list_id?: string;
  custom_variables?: Record<string, string>;
}

// ─── Lead List ────────────────────────────────────────────────────────────────

export interface LeadList {
  id: string;
  name: string;
  timestamp_created?: string;
  timestamp_updated?: string;
}

export interface LeadListVerificationStats {
  total?: number;
  verified?: number;
  unverified?: number;
  risky?: number;
  invalid?: number;
}

// ─── Custom Tag ───────────────────────────────────────────────────────────────

export interface CustomTag {
  id: string;
  name: string;
  label?: string;
  description?: string;
  resource_type?: string;
  timestamp_created?: string;
  timestamp_updated?: string;
}

// ─── Block List Entry ─────────────────────────────────────────────────────────

export interface BlockListEntry {
  id: string;
  value: string;
  type?: string;
  timestamp_created?: string;
  timestamp_updated?: string;
}

// ─── Analytics ────────────────────────────────────────────────────────────────

export interface CampaignAnalytics {
  campaign_id?: string;
  campaign_name?: string;
  emails_sent_count?: number;
  contacted_count?: number;
  new_leads_contacted_count?: number;
  open_count?: number;
  open_count_unique?: number;
  reply_count?: number;
  reply_count_unique?: number;
  /** Уникальные АВТО-ответы (OOO/боты). Список Instantly = unique + automatic_unique. */
  reply_count_automatic_unique?: number;
  bounced_count?: number;
  unsubscribed_count?: number;
  leads_count?: number;
  [key: string]: unknown;
}

export interface CampaignAnalyticsOverview {
  total_campaigns?: number;
  total_leads?: number;
  total_sent?: number;
  total_opened?: number;
  total_replied?: number;
  total_bounced?: number;
  [key: string]: unknown;
}

export interface CampaignStepAnalytics {
  step?: number;
  variant?: number;
  sent?: number;
  opened?: number;
  unique_opened?: number;
  replies?: number;
  unique_replies?: number;
  clicks?: number;
  unique_clicks?: number;
  opportunities?: number;
  [key: string]: unknown;
}

// ─── Subsequence ──────────────────────────────────────────────────────────────

export interface Subsequence {
  id: string;
  name?: string;
  campaign_id?: string;
  status?: number;
  sequences?: CampaignSequence[];
  timestamp_created?: string;
  timestamp_updated?: string;
  [key: string]: unknown;
}

// ─── Email ────────────────────────────────────────────────────────────────────

export interface Email {
  id: string;
  timestamp_created?: string;
  timestamp_email?: string;
  subject?: string;
  body?: { html?: string; text?: string } | string;
  from_address_email?: string;
  to_address_email_list?: string;
  eaccount?: string;
  lead?: string;
  campaign_id?: string;
  thread_id?: string;
  /** 1 = sent by us, 2 = reply from lead, 3 = our reply to lead */
  ue_type?: number;
  is_unread?: number;
  is_focused?: number;
  ai_interest_value?: number;
  i_status?: number;
  content_preview?: string;
  from_address_json?: { address: string; name?: string }[];
  to_address_json?: { address: string; name?: string }[];
  [key: string]: unknown;
}

// ─── Webhook ──────────────────────────────────────────────────────────────────

export interface Webhook {
  id: string;
  name?: string;
  url?: string;
  event_types?: string[];
  enabled?: boolean;
  timestamp_created?: string;
  timestamp_updated?: string;
}

export interface WebhookEventType {
  name: string;
  description?: string;
}

// ─── Email Template ───────────────────────────────────────────────────────────

export interface EmailTemplate {
  id: string;
  name?: string;
  subject?: string;
  body?: string;
  timestamp_created?: string;
  timestamp_updated?: string;
}

// ─── Lead Label ───────────────────────────────────────────────────────────────

export interface LeadLabel {
  id: string;
  name?: string;
  color?: string;
  timestamp_created?: string;
  timestamp_updated?: string;
}

// ─── Warmup Analytics ─────────────────────────────────────────────────────────

export interface WarmupAnalyticsEntry {
  email?: string;
  date?: string;
  sent?: number;
  received?: number;
  landed_inbox?: number;
  landed_spam?: number;
  [key: string]: unknown;
}

// ─── Background Job ──────────────────────────────────────────────────────────

export interface BackgroundJob {
  id: string;
  status?: string;
  type?: string;
  result?: unknown;
  timestamp_created?: string;
  timestamp_updated?: string;
}

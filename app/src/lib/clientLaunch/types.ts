export interface ClientCampaignPreset {
  id: string;
  client_user_id: string;
  email_account_ids: string[];
  daily_limit: number;
  daily_max_leads: number;
  email_gap_minutes: number;
  open_tracking: boolean;
  link_tracking: boolean;
  stop_on_reply: boolean;
  text_only: boolean;
  schedule_from: string; // 'HH:MM'
  schedule_to: string;   // 'HH:MM'
  schedule_days: number[]; // ISO weekdays: 0=Sun..6=Sat (Instantly format)
  schedule_timezone: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClientLaunchSequenceVariant {
  subject?: string;
  body: string;
}

export interface ClientLaunchSequenceStep {
  subject: string;
  body: string;
  wait_days: number;
  /**
   * Optional A/B/C variants. When present, Instantly randomises which variant
   * is sent to each lead. The step's own `subject`+`body` is treated as
   * Variant A, and `variants[]` are extra variants (max 2 → 3 total per step).
   */
  variants?: ClientLaunchSequenceVariant[];
}

/** Max total variants per step (Variant A is the step itself + N entries in variants[]). */
export const CLIENT_LAUNCH_MAX_VARIANTS_PER_STEP = 3;

/**
 * Schedule override that the client can submit per-launch from the launch UI.
 * Defaults are pre-filled from the preset; override completely replaces preset
 * schedule fields when present (no partial merge).
 */
export interface ClientLaunchScheduleOverride {
  /** 'HH:MM' 24h. */
  from: string;
  /** 'HH:MM' 24h. */
  to: string;
  /** ISO weekdays Sunday=0..Saturday=6 (Instantly format). */
  days: number[];
  /** IANA timezone id. Legacy values (Europe/Moscow, …) will be normalized downstream. */
  timezone: string;
}

export interface ClientLaunchBehaviorOverride {
  open_tracking: boolean;
  stop_on_reply: boolean;
}

export interface ClientLaunchSequence {
  name: string;
  steps: ClientLaunchSequenceStep[];
}

/**
 * How CSV/XLSX columns map to Instantly lead fields.
 * Values are header names from the uploaded file.
 *
 * Standard fields: email (required), first_name, last_name, company_name, website, phone.
 * Anything not mapped to a standard field is passed through as a custom variable
 * keyed by the header name unless `custom_variables_mapping` overrides the key.
 */
export interface ClientLaunchColumnMapping {
  email: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  website?: string;
  phone?: string;
  /** Optional: explicit { variable_key: header_name } overrides for custom variables. */
  custom_variables_mapping?: Record<string, string>;
}

export type LaunchStatus = 'uploading' | 'active' | 'paused' | 'failed' | 'completed';

export interface ClientCampaignLaunch {
  id: string;
  client_user_id: string;
  preset_id: string | null;
  instantly_campaign_id: string | null;
  campaign_name: string;
  sequence_steps: ClientLaunchSequenceStep[];
  column_mapping: ClientLaunchColumnMapping;
  uploaded_rows: number;
  accepted_rows: number;
  skipped_rows: number;
  status: LaunchStatus;
  error_message: string | null;
  created_at: string;
}

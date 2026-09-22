import type { TlsMode } from './mailboxImport';

export type MailboxStatus = 'pending' | 'verified' | 'failed' | 'disabled';
export type CampaignStatus = 'draft' | 'running' | 'paused' | 'done';
export type RecipientStatus = 'active' | 'replied' | 'bounced' | 'unsubscribed' | 'finished' | 'stopped';
export type MessageStatus = 'scheduled' | 'sending' | 'sent' | 'failed' | 'canceled' | 'unknown';
export type ReplyKind = 'human' | 'auto_reply' | 'bounce' | 'warmup' | 'unknown';

/** password — пароль приложения из выгрузки; google_sa — ключ служебного аккаунта. */
export type MailboxAuthType = 'password' | 'google_sa';

export interface MailboxRow {
  id: string;
  provider: string;
  auth_type: MailboxAuthType;
  email: string;
  display_name: string | null;
  username: string;
  smtp_host: string;
  smtp_port: number;
  smtp_tls_mode: TlsMode;
  imap_host: string | null;
  imap_port: number;
  /** null у ящиков с входом по ключу: хранить там нечего. */
  secret_encrypted: string | null;
  /** Галочка «берём в рассылку»: решение человека, синхронизация её не трогает. */
  enabled: boolean;
  /** Что про ящик думает сам Google на момент последней синхронизации каталога. */
  google_state: 'active' | 'suspended' | 'missing' | null;
  /** Админ Workspace, из чьего каталога пришёл ящик (их может быть несколько). */
  google_account: string | null;
  status: MailboxStatus;
  daily_campaign_limit: number;
  daily_total_limit: number;
  last_verified_at: string | null;
  last_error: string | null;
  last_send_at: string | null;
  imap_last_uid: number | null;
  imap_uidvalidity: string | null;
  imap_checked_at: string | null;
}

export interface CampaignRow {
  id: string;
  name: string;
  status: CampaignStatus;
  timezone: string;
  send_hour_from: number;
  send_hour_to: number;
  send_weekdays: number[];
  gap_seconds: number;
  gap_jitter_seconds: number;
  started_at: string | null;
}

export interface StepRow {
  id: string;
  campaign_id: string;
  step_no: number;
  /** Задержка от предыдущего шага в часах; у первого письма игнорируется. */
  delay_hours: number;
  subject: string;
  body: string;
}

export interface RecipientRow {
  id: string;
  campaign_id: string;
  email: string;
  name: string | null;
  vars: Record<string, string>;
  status: RecipientStatus;
  mailbox_id: string | null;
  last_step_sent: number;
  next_step_at: string | null;
  thread_message_id: string | null;
}

export interface MessageRow {
  id: string;
  campaign_id: string;
  recipient_id: string;
  mailbox_id: string;
  step_no: number;
  to_email: string;
  subject: string;
  body: string;
  message_id: string;
  in_reply_to: string | null;
  status: MessageStatus;
  scheduled_at: string;
  attempts: number;
}

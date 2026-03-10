export type CampaignStatus = 'stopped' | 'running' | 'paused' | 'error';
export type DialogStatus = 'none' | 'lead' | 'not_lead' | 'later';
export type JobAction = 'start' | 'stop' | 'restart';
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';
export type LogLevel = 'info' | 'warning' | 'error';

export interface OpenAISettings {
  system_prompt: string;
  project_name: string;
  trigger_phrases_positive: string;
  trigger_phrases_negative: string;
  target_chats_positive: string;
  target_chats_negative: string;
  use_fallback_on_fail: boolean;
  fallback_text: string;
}

export interface FollowUpSettings {
  enabled: boolean;
  delay_hours: number;
  delay_minutes?: number; // опционально для обратной совместимости
  prompt: string;
}

export interface TelegramSettings {
  forward_limit: number;
  reply_only_if_previously_wrote: boolean;
  history_limit: number;
  pre_read_delay_range: [number, number];
  read_reply_delay_range: [number, number];
  account_loop_delay_range: [number, number];
  dialog_wait_window_range: [number, number];
  sleep_periods: string[];
  timezone_offset: number;
  ignore_bot_usernames: boolean;
  ignore_no_username: boolean;
  account_cooldown_hours: number;
  follow_up: FollowUpSettings;
}

export interface OutreachCampaign {
  id: string;
  user_id: string;
  name: string;
  status: CampaignStatus;
  openai_settings: OpenAISettings;
  telegram_settings: TelegramSettings;
  created_at: string;
  updated_at: string;
}

export interface OutreachProxy {
  id: string;
  campaign_id: string;
  url: string;
  name: string;
  is_active: boolean;
  created_at: string;
}

export interface OutreachAccount {
  id: string;
  campaign_id: string;
  session_name: string;
  api_id: number;
  api_hash: string;
  phone: string;
  proxy_id: string | null;
  session_data: string;
  is_active: boolean;
  cooldown_until: string | null;
  created_at: string;
}

export interface DialogMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
}

export interface OutreachDialog {
  id: string;
  campaign_id: string;
  account_id: string;
  tg_user_id: number;
  tg_username: string | null;
  messages: DialogMessage[];
  status: DialogStatus;
  last_message_at: string | null;
  created_at: string;
}

export interface OutreachProcessed {
  id: string;
  campaign_id: string;
  tg_user_id: number;
  tg_username: string | null;
  processed_at: string;
}

export interface OutreachJob {
  id: string;
  campaign_id: string;
  user_id: string;
  action: JobAction;
  status: JobStatus;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface OutreachLog {
  id: number;
  campaign_id: string;
  level: LogLevel;
  message: string;
  created_at: string;
}

export const DEFAULT_OPENAI_SETTINGS: OpenAISettings = {
  system_prompt: '',
  project_name: '',
  trigger_phrases_positive: '',
  trigger_phrases_negative: '',
  target_chats_positive: '',
  target_chats_negative: '',
  use_fallback_on_fail: false,
  fallback_text: '',
};

const DEFAULT_FOLLOW_UP_PROMPT = 'Напиши короткое напоминание о себе. Вежливо напомни о предложении и спроси, актуально ли оно ещё. Если не актуально - попроси сообщить об этом. Сообщение должно быть кратким (2-3 предложения).';

export const DEFAULT_FOLLOW_UP: FollowUpSettings = {
  enabled: false,
  delay_hours: 24,
  delay_minutes: 0,
  prompt: DEFAULT_FOLLOW_UP_PROMPT,
};

export const DEFAULT_TELEGRAM_SETTINGS: TelegramSettings = {
  forward_limit: 5,
  reply_only_if_previously_wrote: true,
  history_limit: 20,
  pre_read_delay_range: [5, 10],
  read_reply_delay_range: [5, 10],
  account_loop_delay_range: [300, 600],
  dialog_wait_window_range: [40, 60],
  sleep_periods: ['00:00-08:00'],
  timezone_offset: 3,
  ignore_bot_usernames: true,
  ignore_no_username: true,
  account_cooldown_hours: 5,
  follow_up: DEFAULT_FOLLOW_UP,
};

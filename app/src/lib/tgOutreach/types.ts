export interface TgOutreachTag {
  id: string;
  name: string;
  color: string;
  created_by: string | null;
  created_at: string;
}

export type ProxyType = 'HTTP' | 'SOCKS4' | 'SOCKS5';

export interface TgOutreachProxy {
  id: string;
  ip: string;
  port: number;
  login: string;
  password: string;
  type: ProxyType;
  notes: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  tags?: TgOutreachTag[];
}

export type AccountFormat = 'tdata' | 'session_json';
export type AccountStatus = 'active' | 'banned' | 'frozen' | 'limited';

export interface TgOutreachAccount {
  id: string;
  format: AccountFormat;
  session_data: Record<string, unknown>;
  phone: string;
  first_name: string;
  last_name: string;
  username: string;
  bio: string;
  avatar_url: string;
  proxy_id: string | null;
  status: AccountStatus;
  account_price: number;
  notes: string;

  max_invites_per_day: number;
  max_messages_per_day: number;
  max_chat_messages_per_day: number;
  max_contact_adds_per_day: number;
  max_story_views_per_day: number;
  max_neurocomment_posts_per_day: number;
  control_tg_request_limit: boolean;

  created_by: string | null;
  created_at: string;
  updated_at: string;

  tags?: TgOutreachTag[];
  proxy?: TgOutreachProxy | null;
}

export type AccountAction =
  | 'check_status'
  | 'check_spambot'
  | 'sync_profile'
  | 'request_unfreeze'
  | 'remove_spamblock'
  | 'unblock';

export type CampaignStatus = 'stopped' | 'running' | 'paused' | 'error';
export type DialogStatus = 'none' | 'lead' | 'not_lead' | 'later';
export type JobAction = 'start' | 'stop' | 'restart' | 'refetch_messages';
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';
export type LogLevel = 'info' | 'warning' | 'error';

export interface OpenAISettings {
  llm_model?: string;
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
  delay_minutes?: number;
  prompt: string;
}

export interface TelegramSettings {
  forward_limit: number;
  reply_only_if_previously_wrote: boolean;
  auto_allow_new_dialogs: boolean;
  history_limit: number;
  pre_read_delay_range: [number, number];
  read_reply_delay_range: [number, number];
  account_loop_delay_range: [number, number];
  dialog_wait_window_range: [number, number];
  sleep_periods: string[];
  timezone_offset: number;
  ignore_bot_usernames: boolean;
  ignore_no_username: boolean;
  blocked_usernames: string[];
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
  /** Storage path for .session file (TDesktop SQLite), e.g. campaign_id/account_id.session */
  session_file_path?: string | null;
  is_active: boolean;
  cooldown_until: string | null;
  /** Consecutive AUTH_KEY_DUPLICATED errors during connect. See migration
   *  20260521_0002. Reset on successful connect; auto-disable at 3. */
  auth_key_dup_count?: number;
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
  tg_is_bot?: boolean;
  can_send?: boolean;
  /**
   * Audit-поля смены can_send. Заполняются и API-эндпоинтом ручного
   * переключения, и blockedUsers helpers, и воркером (`disableDialogIfUnreachable`).
   * NULL до первой смены — диалог унаследовал дефолт при создании.
   */
  can_send_changed_at?: string | null;
  /** UUID пользователя портала. NULL = переключил воркер автоматически. */
  can_send_changed_by?: string | null;
  /**
   * Короткий код источника последнего изменения can_send:
   *   - 'manual'                 — оператор кликнул тумблер в UI;
   *   - 'blocklist_add'          — добавили в ЧС (addBlockedUser);
   *   - 'blocklist_remove'       — убрали из ЧС (removeBlockedUser);
   *   - 'tg_user_deactivated'    — Telegram вернул INPUT_USER_DEACTIVATED;
   *   - 'tg_peer_invalid'        — PEER_ID_INVALID;
   *   - 'tg_user_blocked_bot'    — USER_IS_BLOCKED;
   *   - 'tg_user_banned_in_channel' — USER_BANNED_IN_CHANNEL;
   *   - 'tg_unreachable'         — fallback для прочих кодов недоступности.
   */
  can_send_changed_reason?: string | null;
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

export interface OutreachBlockedUser {
  user_id: string;
  tg_user_id: number;
  tg_username: string | null;
  reason: string | null;
  created_at: string;
}

export const DEFAULT_OPENAI_SETTINGS: OpenAISettings = {
  llm_model: 'policy/tg-outreach',
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
  auto_allow_new_dialogs: true,
  history_limit: 20,
  pre_read_delay_range: [5, 10],
  read_reply_delay_range: [5, 10],
  account_loop_delay_range: [300, 600],
  dialog_wait_window_range: [40, 60],
  sleep_periods: ['00:00-08:00'],
  timezone_offset: 3,
  ignore_bot_usernames: true,
  ignore_no_username: true,
  blocked_usernames: ['SpamBot'],
  account_cooldown_hours: 5,
  follow_up: DEFAULT_FOLLOW_UP,
};

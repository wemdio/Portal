import { DEFAULT_MAX_MESSAGE_CHARS } from './firstTouch/validateMessage';

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

/**
 * `warming` — идёт прогрев аккаунтов (см. lib/tgOutreach/warmup/). Прогрев и
 * боевой аутрич взаимоисключающие, поэтому это именно статус кампании, а не
 * отдельный флаг: воркер не берёт такие кампании в боевой auto-resume, а API
 * отказывает в запуске аутрича.
 */
export type CampaignStatus = 'stopped' | 'running' | 'paused' | 'error' | 'warming';
export type DialogStatus = 'none' | 'lead' | 'not_lead' | 'later';
export type JobAction =
  | 'start'
  | 'stop'
  | 'restart'
  | 'refetch_messages'
  | 'warmup_start'
  | 'warmup_stop';
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
  /**
   * Куда уходит кандидат в партнёры по кнопке «Передать партнёра».
   *
   * Отдельно от `target_chats_positive`: заинтересованного клиента и человека,
   * который хочет стать партнёром программы, разбирают разные люди. Пусто —
   * используем чат положительного триггера, чтобы кнопка работала сразу, а не
   * молча упиралась в незаполненную настройку.
   */
  target_chats_partner?: string;
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
  /**
   * Отвечать только тем, кому мы писали по базе этой кампании.
   *
   * Без этого бот отвечает в любом диалоге, где есть наше исходящее, — а в
   * купленном аккаунте это ещё и чаты прогрева между своими же аккаунтами.
   * Кампании, заведённые до настройки, поля не имеют: `?` означает «выключено»,
   * чтобы не менять молча поведение уже идущих рассылок.
   */
  reply_only_to_base_contacts?: boolean;
  auto_allow_new_dialogs: boolean;
  history_limit: number;
  pre_read_delay_range: [number, number];
  read_reply_delay_range: [number, number];
  account_loop_delay_range: [number, number];
  /**
   * Пауза между полными кругами по всем аккаунтам, в секундах. Раньше
   * cycleDelay был захардкожен в 30с и после ~3 часов прохождения 29 аккаунтов
   * воркер бежал на новый круг уже через 30с — на «горячих» mobile-pool IP
   * этого мало, Telegram продолжал отвечать silent throttle. Делаем настройкой
   * с дефолтом [300, 600] (5-10 минут рандом).
   */
  cycle_delay_range: [number, number];
  /**
   * НЕ ИСПОЛЬЗУЕТСЯ. Ни одна строка кода не читает это значение, поэтому поле
   * убрано с экрана настроек: оператор крутил ручку, которая ни на что не
   * влияет. Ключ оставлен, чтобы не переписывать сохранённые кампании —
   * удалять его вместе с миграцией, если решим, что окно ожидания не нужно.
   */
  dialog_wait_window_range: [number, number];
  sleep_periods: string[];
  timezone_offset: number;
  ignore_bot_usernames: boolean;
  ignore_no_username: boolean;
  blocked_usernames: string[];
  account_cooldown_hours: number;
  /**
   * Сколько первых сообщений аккаунт отправляет в сутки. Ноль или отсутствие
   * поля = первое касание выключено; отдельного переключателя не нужно.
   * Кампании, заведённые до этой фичи, поля не имеют — отсюда `?`.
   */
  first_touch_per_account_per_day?: number;
  /**
   * Максимальная длина первого сообщения. Длиннее — контакт откладывается, а не
   * отправляется. Это фильтр мусора в файле (съехавшая колонка, обрезанная
   * строка), а не правило Telegram, поэтому порог должен быть под рукой у
   * оператора: база с ровными текстами по 430–460 знаков при пороге 400 не
   * отправляется вообще никогда. Ноль или отсутствие поля = дефолт 400,
   * потолок — предел Telegram в 4096.
   */
  first_touch_max_chars?: number;
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
  /**
   * Личность самого аккаунта — заполняется getMe() при старте прогрева
   * (миграция 20260803_0006). Боевому циклу не нужна: он всегда отвечает уже
   * известному собеседнику. Прогреву нужна, чтобы аккаунты могли адресовать
   * друг друга, а боевому циклу — чтобы не принять свой же аккаунт за лида.
   */
  tg_user_id?: number | null;
  tg_username?: string | null;
  identity_checked_at?: string | null;
  /**
   * Профиль, который реально стоит в Telegram (миграция 20260806_0002).
   * Заполняется при правке профиля и при чтении из Telegram; `avatar_url` —
   * копия фото в хранилище портала, чтобы список не ходил за картинками в
   * Telegram. `profile_synced_at` = NULL — профиль ещё ни разу не читали.
   */
  first_name?: string;
  last_name?: string;
  bio?: string;
  avatar_url?: string;
  profile_synced_at?: string | null;
  /**
   * Итог последней проверки аккаунта (миграция 20260810_0001). `other_sessions`
   * — чужие активные сеансы Telegram: по ним видно, что в аккаунт заходит
   * кто-то ещё, а это главный подозреваемый в массовых потерях сессий.
   */
  check_status?: string | null;
  check_detail?: string | null;
  checked_at?: string | null;
  other_sessions?: Array<{
    device: string;
    platform: string;
    app: string;
    country: string;
    ip: string;
    last_active: string;
    created: string;
  }> | null;
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
  /**
   * Последняя передача этого диалога — приклеивается роутом списка, в самой
   * таблице диалогов такого поля нет.
   *
   * Живая (pending/sent) гасит кнопки: передача на диалог одна, и узнавать об
   * этом из ошибки после подтверждения — плохой способ. Упавшая кнопок не
   * гасит, но показывает причину прямо в строке человека: повторить можно
   * только зная, что именно сломалось.
   */
  forward?: {
    kind: 'lead' | 'partner';
    status: 'pending' | 'sent' | 'failed';
    sent_at: string | null;
    /** Причина сбоя целиком — по ней оператор чинит и повторяет. */
    error_message: string | null;
  } | null;
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
  target_chats_partner: '',
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
  // Новым кампаниям — включено: почти всегда нужно именно это, а обратное
  // (отвечать всем подряд из старых чатов аккаунта) приходится осознанно
  // разрешать.
  reply_only_to_base_contacts: true,
  auto_allow_new_dialogs: true,
  history_limit: 20,
  pre_read_delay_range: [5, 10],
  read_reply_delay_range: [5, 10],
  account_loop_delay_range: [300, 600],
  cycle_delay_range: [300, 600],
  dialog_wait_window_range: [40, 60],
  sleep_periods: ['00:00-08:00'],
  timezone_offset: 3,
  ignore_bot_usernames: true,
  ignore_no_username: true,
  blocked_usernames: ['SpamBot'],
  account_cooldown_hours: 5,
  first_touch_max_chars: DEFAULT_MAX_MESSAGE_CHARS,
  follow_up: DEFAULT_FOLLOW_UP,
};

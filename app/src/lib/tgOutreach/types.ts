/**
 * Служебный аккаунт Telegram (777000): коды входа и сервисные уведомления.
 *
 * Это не собеседник, и отвечать ему нельзя — правило общее для всех кампаний,
 * а не настройка. Чат с ним приходит непрочитанным при каждом логине аккаунта
 * (код подтверждения), поэтому без явного скипа воркер таскал его в список
 * диалогов кампании как обычного человека: там копились строки «ID 777000» с
 * кодами доступа — оператор видит в разметке мусор, а воркер звал на него GPT.
 * Поэтому 777000 вырезан отовсюду: цикл воркера, напоминания и догоняющие
 * ответы, запись диалога, ручная отправка и сам список.
 */
export const TG_SERVICE_NOTIFICATIONS_USER_ID = 777000;

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
  /**
   * Убрано с экрана 09.09.2026 вместе с «Чатом для пересылки (−)»: на практике
   * всё решает положительный триггер. Воркер по-прежнему читает сохранённое
   * значение: фраза в ответе бота помечает диалог «не лид» и закрывает
   * переписку — это поведение осталось, исчезла только настройка.
   */
  trigger_phrases_negative: string;
  target_chats_positive: string;
  /**
   * Убрано с экрана 09.09.2026. Пусто (дефолт) — отрицательный триггер только
   * помечает диалог, никуда не пересылает. Ключ оставлен, чтобы не переписывать
   * сохранённые кампании, где чат был задан.
   */
  target_chats_negative: string;
  /**
   * Убрано с экрана 09.09.2026: и клиент, и кандидат в партнёры — оба
   * «положительный триггер», кнопка «Передать партнёра» шлёт в чат (+).
   * Ключ и сохранённые значения оставлены — маршрут пересылки продолжает
   * их читать.
   */
  target_chats_partner?: string;
  /**
   * Убрано с экрана 09.09.2026 вместе с резервным текстом: при ошибке модели
   * бот теперь просто молчит. Работает только в кампаниях, где флаг уже был
   * включён; включить заново с экрана больше нельзя.
   */
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
  /**
   * Убрано с экрана 09.09.2026. Дефолт 5: сколько последних сообщений диалога
   * уходит в чат-приёмник при пересылке лида. Сохранённое значение кампании
   * воркер продолжает читать.
   */
  forward_limit: number;
  reply_only_if_previously_wrote: boolean;
  /**
   * УСТАРЕЛО, воркер это поле больше не читает: с 10.09.2026 ответы только
   * контактам из баз кампании — поведение инструмента, а не настройка.
   * Ключ оставлен, чтобы сохранённые кампании не теряли поле при чтении.
   */
  reply_only_to_base_contacts?: boolean;
  auto_allow_new_dialogs: boolean;
  /**
   * Убрано с экрана 09.09.2026. Дефолт 20: сколько последних сообщений диалога
   * модель читает перед ответом. Сохранённое значение кампании читается как раньше.
   */
  history_limit: number;
  /**
   * НЕ ИСПОЛЬЗУЕТСЯ. Убрано с экрана 09.09.2026: пауза перед прочтением
   * захардкожена в рандом 5–15 сек (campaignLoop, PRE_READ_DELAY_RANGE_SEC) —
   * живой человек не открывает чат в ту же секунду, настраивать это незачем.
   * Ключ оставлен, чтобы не переписывать сохранённые кампании.
   */
  pre_read_delay_range: [number, number];
  read_reply_delay_range: [number, number];
  account_loop_delay_range: [number, number];
  /**
   * Сколько аккаунтов кампании работают одновременно.
   *
   * Ждать друг друга им незачем — у каждого своя сессия и свой прокси. Раньше
   * обход был строго последовательным, и круг по полусотне аккаунтов занимал
   * десять часов, из которых восемь уходило в паузы между ними.
   *
   * Верхнюю границу задаёт не Telegram, а прокси-хост: полсотни параллельных
   * MTProto-соединений упрутся в него. Поле необязательное — у кампаний,
   * заведённых до настройки, берётся значение по умолчанию.
   */
  account_concurrency?: number;
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
  /**
   * УСТАРЕЛО, воркер это поле больше не читает: ботов пропускаем всегда
   * (с 10.09.2026). Ключ оставлен ради сохранённых кампаний.
   */
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
   * отправляется.
   *
   * УСТАРЕЛО, воркер это поле больше не читает: с 10.09.2026 порог один на все
   * кампании — DEFAULT_MAX_MESSAGE_CHARS (600 знаков, меняется переменной
   * окружения TG_FIRST_TOUCH_MAX_CHARS). Ключ оставлен ради сохранённых кампаний.
   */
  first_touch_max_chars?: number;
  /**
   * Минимальная пауза между порциями первых сообщений одного аккаунта,
   * в минутах. Суточная норма больше не уходит одной очередью за минуты:
   * аккаунт отправляет порцию и молчит до истечения паузы. Ноль — порции без
   * паузы (старое поведение). Отсутствие поля = 60 минут: 09.09.2026 в ATOL-1
   * Telegram выдавал PEER_FLOOD свежим аккаунтам после 3–6 сообщений подряд,
   * и «4 в сутки» не спасало — спасает расстояние между отправками.
   */
  first_touch_gap_minutes?: number;
  /**
   * Сколько первых сообщений аккаунт отправляет за одну порцию (между паузами
   * `first_touch_gap_minutes`). Отсутствие поля или меньше единицы = 2.
   * Суточная норма остаётся потолком: порции лишь размазывают её по дню.
   */
  first_touch_per_gap?: number;
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
  /**
   * Сколько аккаунтов кампании сейчас на прогреве. Считает ручка списка
   * кампаний; в самой таблице этого поля нет.
   *
   * Нужно шапке: с тех пор как прогрев перестал останавливать кампанию,
   * «Запущена» перестала быть полным ответом — часть аккаунтов может греться
   * параллельно.
   */
  warming_accounts?: number;
}

export interface OutreachProxy {
  id: string;
  campaign_id: string;
  url: string;
  name: string;
  is_active: boolean;
  created_at: string;
  /**
   * Список, в который прокси входит (миграция 20260909_0005). null = «Неопределённые»:
   * прокси есть в кампании, но ни в один именованный список не положен. Это
   * нормальное состояние, не ошибка: так выглядят все прокси, добавленные до
   * введения списков.
   */
  proxy_list_id?: string | null;
  /**
   * Здоровье прокси (миграция 20260603_0001). Ручка отдаёт строку целиком, и
   * экран этими полями уже пользуется — колонка «Здоровье прокси» и выбор
   * прокси при назначении. Необязательные: старые строки заполнены не все, а
   * рассылка пишет их по ходу кругов.
   */
  consecutive_errors?: number | null;
  last_error_at?: string | null;
  last_error_reason?: string | null;
  cooldown_until?: string | null;
  last_used_at?: string | null;
  total_uses?: number | null;
  total_errors?: number | null;
}

/**
 * Именованная группа прокси внутри кампании (миграция 20260909_0005).
 *
 * В UI не хранится отдельно «Неопределённый» — это виртуальный список,
 * объединяющий все прокси кампании с proxy_list_id = NULL. Так сделан потому,
 * что у существующих 140 прокси этого поля нет, и до того, как оператор
 * разнесёт их по спискам, «Неопределённые» — это весь кампанийный пул.
 */
export interface OutreachProxyList {
  id: string;
  campaign_id: string;
  name: string;
  created_at: string;
}

/**
 * Сводка по списку: для шапки на вкладке Прокси.
 *
 * Считается на сервере из текущего состояния таблицы прокси. Возраст — это
 * «сколько часов прошло с момента создания строки», не «как долго прокси
 * реально работал»: окно до отказа мы не храним, а единственный надёжный
 * признак «умер» — `is_active = false` сейчас. Поэтому отдельно даём
 * `avg_age_hours_at_death` по выключенным: если их в списке хватает, это
 * оценка реального срока жизни партии; если нет — поле не показываем.
 */
export interface OutreachProxyListStats {
  proxy_count: number;
  /** Сейчас работает: `is_active` и нет активного cooldown (см. `isProxyHealthy`). */
  active_count: number;
  /** Сейчас выключен: `is_active = false`. */
  dead_count: number;
  /** Средний возраст всех прокси списка, часы. null если в списке пусто. */
  avg_age_hours: number | null;
  /** Средний возраст выключенных прокси списка, часы. null если выключенных нет. */
  avg_age_hours_at_death: number | null;
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
   * Кругов подряд, где ни один ник порции не резолвился, а @SpamBot
   * ограничений не подтвердил (миграция 20260906_0001). Так выглядит тихая
   * заморозка Telegram: явного кода ошибки у неё нет. На пороге круг уводит
   * аккаунт на паузу с диагнозом; первая успешная отправка обнуляет.
   */
  resolve_blank_rounds?: number;
  /**
   * До этого момента аккаунт только греется и в боевую рассылку не берётся
   * (миграция 20260907_0001). NULL или прошедшая дата — аккаунт боевой.
   *
   * Срок, а не флаг: партия, поставленная греться на неделю, сама уходит в бой
   * и не ждёт, пока о ней вспомнят.
   */
  warmup_until?: string | null;
  /**
   * Обжалование заморозки (миграция 20260907_0002).
   *
   * `freeze_appeal_url` приносит проверка аккаунта — это адрес, по которому
   * Telegram сам предлагает обжаловать. Остальное — очередь: оператор нажал,
   * воркер отправил своим соединением и записал итог.
   */
  freeze_appeal_url?: string | null;
  appeal_requested_at?: string | null;
  appeal_requested_by_name?: string | null;
  appeal_text?: string | null;
  appeal_status?: string | null;
  appeal_detail?: string | null;
  appealed_at?: string | null;
  /**
   * Заказ на правку профиля с работающей кампании (миграция 20260908_0001).
   *
   * Ручка профиля открывает своё соединение и работает только на остановленной
   * кампании. Заказ применяет круг — тем соединением, что уже открыто.
   */
  profile_requested_at?: string | null;
  profile_requested_by_name?: string | null;
  profile_payload?: unknown;
  profile_status?: string | null;
  profile_detail?: string | null;
  profile_applied_at?: string | null;
  /**
   * До этого момента аккаунт не берётся в боевую рассылку после смены имени или
   * ника (миграция 20260908_0002). Прогрев между своими при этом разрешён.
   */
  profile_rest_until?: string | null;
  /**
   * Страна партии со слов оператора (ISO-код). Нужна, пока телефон неизвестен:
   * у залитых tdata его нет до первого подключения, а прокси подбирать надо
   * уже сейчас (миграция 20260908_0003).
   */
  country_code?: string | null;
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
  /**
   * Проверка, заказанная на работающей кампании (миграция 20260827_0001).
   * Подключаться из портала к занятой воркером сессии нельзя, поэтому нажатие
   * только ставит отметку, а выполняет проверку воркер своим соединением в
   * ближайшем круге. NULL — заказа нет.
   */
  check_requested_at?: string | null;
  check_requested_by_name?: string | null;
  /**
   * Когда боевой круг в последний раз брал аккаунт в работу (миграция
   * 20260828_0001). Задаёт порядок обхода: первым идёт тот, до кого дольше
   * всех не доходили. NULL — не брали ни разу.
   */
  last_cycle_at?: string | null;
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
   * Автоматическая передача менеджеру по положительному триггеру: ушло или нет,
   * куда и почему не ушло. В отличие от `forward` — не задача в очереди, а факт
   * о том, что воркер уже сделал сам. Статус «Лид» на этот вопрос не отвечает:
   * его точно так же ставит оператор руками.
   *
   * Разбирает эти поля `lib/tgOutreach/autoForward.ts`.
   */
  auto_forwarded_at?: string | null;
  auto_forward_chat?: string | null;
  auto_forward_error?: string | null;
  /**
   * Последняя передача этого диалога — приклеивается роутом списка, в самой
   * таблице диалогов такого поля нет.
   *
   * Живая (pending/sent) гасит кнопки: передача на диалог одна, и узнавать об
   * этом из ошибки после подтверждения — плохой способ. Упавшая кнопок не
   * гасит, но показывает причину прямо в строке человека: повторить можно
   * только зная, что именно сломалось. Снятая оператором (`cancelled`) ведёт
   * себя как упавшая: до менеджера не дошла, кнопки возвращает.
   */
  /**
   * Из какой базы («гипотезы») пришёл этот человек — приклеивается роутом
   * списка, в самой таблице диалогов такого поля нет: диалог заводится по
   * входящему из Telegram и про базу ничего не знает.
   *
   * `alsoIn` — другие базы кампании с тем же ником. Пересечения бывают: базы
   * собирают из соседних чатов, а дедупликация в портале только внутри базы.
   */
  base?: {
    id: string;
    name: string;
    alsoIn: string[];
  } | null;
  forward?: {
    kind: 'lead' | 'partner';
    status: 'pending' | 'sent' | 'failed' | 'cancelled';
    sent_at: string | null;
    /**
     * Почему отправки не было: у сорвавшейся — причина сбоя целиком, по ней
     * оператор чинит и повторяет; у снятой — кто её снял.
     */
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
  // Не читается (см. поле выше) — выровнено с захардкоженным рандомом 5–15.
  pre_read_delay_range: [5, 15],
  read_reply_delay_range: [5, 10],
  // Пауза между кругами одного аккаунта. Была [300, 600] — при
  // последовательном обходе она же служила промежутком между РАЗНЫМИ
  // аккаунтами, и круг по полусотне занимал десять часов. Обход стал
  // параллельным, разным аккаунтам ждать друг друга больше не нужно, и от
  // паузы требуется только то, ради чего она есть: не давать одному номеру
  // работать очередями подряд.
  account_loop_delay_range: [60, 120],
  cycle_delay_range: [300, 600],
  dialog_wait_window_range: [40, 60],
  sleep_periods: ['00:00-08:00'],
  timezone_offset: 3,
  ignore_bot_usernames: true,
  ignore_no_username: true,
  blocked_usernames: ['SpamBot'],
  account_cooldown_hours: 24,
  // Порции первых сообщений — по умолчанию включены (60 минут / 2 письма):
  // очередь за полминуты покупает PEER_FLOOD быстрее, чем успевает сработать
  // суточная норма. Ноль в gap выключает разнос обратно в очередь.
  first_touch_gap_minutes: 60,
  first_touch_per_gap: 2,
  // Норма первых сообщений: 3 письма на аккаунт в сутки — нижняя ступень
  // лестницы из подсказки на экране. Раньше ключа в дефолтах не было вовсе,
  // и новая кампания заводилась с выключенной рассылкой (undefined → 0).
  first_touch_per_account_per_day: 3,
  follow_up: DEFAULT_FOLLOW_UP,
};

/**
 * Types for TG User Parser (GramJS-based).
 */

export type ParseSource = 'chat_messages' | 'chat_members' | 'post_comments';
export type OnlineStatus = 'online' | 'recently' | 'within_week' | 'within_month' | 'long_ago' | 'unknown';

export interface ParsedUser {
  'ID/Username': string;
  ID: number;
  Username: string;
  Имя: string;
  Фамилия: string;
  'Полное имя': string;
  Пол: string;
  Биография: string;
  'Личный канал': string;
  'Статус онлайн': OnlineStatus;
  'Последний раз в сети': string;
  Сообщения: string;
  'Количество сообщений': number;
  'Тип источника': ParseSource;
  'Ссылка на источник': string;
  'Название источника': string;
}

export interface TgParserAccount {
  api_id: number;
  api_hash: string;
  session_data: string;
  proxy_url?: string;
}

export interface ParseOptions {
  links: string[];
  parse_chat_messages: boolean;
  parse_chat_members: boolean;
  parse_post_comments: boolean;
  /** Включает медленное обогащение профиля через users.GetFullUser (био, личный канал). */
  enrich_profile?: boolean;
  message_limit: number;
  filter_online: boolean;
  filter_recently: boolean;
  max_offline_days: number | null;
  account?: TgParserAccount;
  /** Остановиться после N уникальных контактов (с аккаунта: max_contacts_per_run). Без поля — без лимита. */
  max_contacts?: number | null;
  /**
   * Отчёт о ходе работы: какой источник, какой этап, сколько собрано.
   *
   * Обход трёх чатов идёт от минуты до сорока, и до 10.08.2026 всё это время
   * задача молчала — отличить работу от зависания было нельзя. Сбой этого
   * колбэка парсер игнорирует: отчётность не должна ронять сбор.
   */
  onProgress?: (p: ParseProgress) => void | Promise<void>;
  /**
   * Останов по сигналу (деплой, потеря аренды). Проверяется между источниками и
   * раз в 30 секунд внутри этапа: обход прерывается, собранное возвращается со
   * stop_reason='interrupted', задача продолжится с чекпойнта у другого исполнителя.
   */
  signal?: AbortSignal;
  /** Пользователи, набранные до перезапуска (из чекпойнта): подсаживаются в накопитель. */
  initialUsers?: ParsedUser[];
  /**
   * Источник полностью обработан (или окончательно пропущен) — момент для чекпойнта.
   * failure заполнен, если источник не открылся: возобновление обязано помнить
   * такие ссылки, иначе итоговый вердикт задачи после перезапуска будет мягче
   * настоящего.
   */
  onLinkDone?: (link: string, usersSoFar: ParsedUser[], failure?: string) => void | Promise<void>;
}

export interface ParseProgress {
  /** Ссылка на источник, который обходим сейчас. */
  link: string;
  /** Название источника из Telegram — пусто, пока не резолвнули. */
  title?: string;
  stage: 'messages' | 'members' | 'comments';
  /** Этап только начался или уже закончился. */
  phase: 'start' | 'tick' | 'done';
  /** Всего уникальных контактов собрано с начала задачи. */
  total: number;
}

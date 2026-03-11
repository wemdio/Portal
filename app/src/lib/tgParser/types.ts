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
  message_limit: number;
  filter_online: boolean;
  filter_recently: boolean;
  max_offline_days: number | null;
  account?: TgParserAccount;
}

/**
 * Квалифицирующий ИИ автоаутрича RU/EN
 * (docs/superpowers/specs/2026-10-27-auto-outreach-qualifying-ai-design.md).
 */

/** Состояние разговора ИИ с лидом — строка sender_ai_conversations. */
export type AiState = 'active' | 'handed_off' | 'no_reply' | 'closed' | 'stopped' | 'failed';

export type AiFolderKey = 'auto_ru' | 'auto_en';

/** Ответ модели на один ход разговора. */
export interface AiStep {
  /** Подтвердил ли лид, что это ему актуально. */
  relevant: 'yes' | 'no' | 'unclear';
  /** Слоты, телефон или контакт, где и когда обсудить, — как прислал лид. */
  contact: string | null;
  outcome: 'continue' | 'handoff' | 'close' | 'counter_offer';
  /** Текст письма лиду; пустой, если писать не нужно. */
  reply: string;
  /** 1–3 строки для менеджера: кто, что нужно, что прислал. */
  summary: string;
  /** Лид просит больше не писать — отвечать нельзя ни строкой. */
  stopRequested: boolean;
}

/** Что делает движок после хода: решает код, а не модель. */
export type AiDecision =
  | { kind: 'handoff'; letter: string; contact: string; summary: string }
  | { kind: 'reply'; letter: string }
  | { kind: 'close'; letter: string | null }
  | { kind: 'no_reply' };

export interface AiConversationRow {
  recipient_id: string;
  campaign_id: string;
  folder_key: AiFolderKey;
  state: AiState;
  ai_messages: number;
  reminder_sent: boolean;
  last_reply_id: string | null;
  trigger_reply_id: string;
  last_ai_sent_at: string | null;
  next_action_at: string | null;
  handoff_reply_id: string | null;
  handoff_contact: string | null;
  summary: string | null;
  attempts: number;
  last_error: string | null;
  started_at: string;
  updated_at: string;
}

/** Не больше стольких писем ИИ одному лиду (включая напоминание). */
export const MAX_AI_LETTERS = 3;
/** Напоминание — после стольких рабочих дней молчания. */
export const REMINDER_BUSINESS_DAYS = 2;
/** Отвечаем не раньше, чем через столько после письма лида. */
export const REPLY_DELAY_MS = 5 * 60_000;
/** После стольких сбоев модели лид уходит менеджерам прежним путём. */
export const MAX_AI_ATTEMPTS = 3;
/**
 * Начало ошибки, которой manualWorker отменяет письмо ИИ перед отправкой
 * (отписка, ручная метка, ответ оператора). Это не сбой отправки.
 */
export const AI_LETTER_CANCELLED = 'Письмо ИИ отменено';

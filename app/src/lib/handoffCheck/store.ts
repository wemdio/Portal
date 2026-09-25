/**
 * Таблица `handoff_card_checks` (спека
 * `docs/superpowers/specs/2026-09-25-handoff-card-check-design.md`, §«Устройство»,
 * план Task 4). Одна строка на сообщение (`chat_id`, `message_id` уникальны).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Problem } from './checkCard';

export type HandoffCheckStatus = 'ok' | 'problems' | 'no_link' | 'resolved' | 'expired';

export interface HandoffCheckRow {
  id: string;
  chat_id: number;
  message_id: number;
  thread_id: number | null;
  amo_id: number | null;
  message_text: string | null;
  author: string | null;
  stated_amount: number | null;
  stated_source: string | null;
  status: HandoffCheckStatus;
  problems: Problem[];
  /** id нашего предупреждения в чате; 0 — ответ отправляется (см. `REPLY_PENDING`). */
  reply_message_id: number | null;
  /** Когда в чат впервые ушло предупреждение (проблемы или нет ссылки) — от него считаем напоминание. */
  warned_at: string | null;
  first_checked_at: string;
  last_checked_at: string;
  reminded_at: string | null;
  resolved_at: string | null;
}

/** Поля строки, которые заполняет вызывающий код при создании/обновлении. */
export type HandoffCheckUpsert = {
  chat_id: number;
  message_id: number;
  thread_id?: number | null;
  amo_id?: number | null;
  message_text?: string | null;
  author?: string | null;
  stated_amount?: number | null;
  stated_source?: string | null;
  status: HandoffCheckStatus;
  problems?: Problem[];
  reply_message_id?: number | null;
  warned_at?: string | null;
  last_checked_at?: string;
  reminded_at?: string | null;
  resolved_at?: string | null;
};

const TABLE = 'handoff_card_checks';

export async function getCheck(
  db: SupabaseClient,
  chatId: number,
  messageId: number,
): Promise<HandoffCheckRow | null> {
  const { data, error } = await db
    .from(TABLE)
    .select('*')
    .eq('chat_id', chatId)
    .eq('message_id', messageId)
    .maybeSingle();
  if (error) throw error;
  return (data as HandoffCheckRow | null) ?? null;
}

export async function upsertCheck(
  db: SupabaseClient,
  row: HandoffCheckUpsert,
): Promise<HandoffCheckRow> {
  const { data, error } = await db
    .from(TABLE)
    .upsert(
      { ...row, last_checked_at: row.last_checked_at ?? new Date().toISOString() },
      { onConflict: 'chat_id,message_id' },
    )
    .select('*')
    .single();
  if (error) throw error;
  return data as HandoffCheckRow;
}

/** Открытые проверки (`problems` | `no_link`) — источник для ежедневного прохода. */
export async function listOpen(db: SupabaseClient): Promise<HandoffCheckRow[]> {
  const { data, error } = await db
    .from(TABLE)
    .select('*')
    .in('status', ['problems', 'no_link'])
    .order('first_checked_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as HandoffCheckRow[];
}

/** Самая ранняя проверка в таблице — момент первого запуска бота; null — таблица пуста. */
export async function earliestCheckAt(db: SupabaseClient): Promise<string | null> {
  const { data, error } = await db
    .from(TABLE)
    .select('first_checked_at')
    .order('first_checked_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as { first_checked_at: string } | null)?.first_checked_at ?? null;
}

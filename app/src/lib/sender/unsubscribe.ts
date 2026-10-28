import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Просьба больше не писать — общий путь для repliesWorker (стоп-слова в ответе)
 * и ИИ-квалификатора (просьбу понял модель). Работает с переданным клиентом и
 * не бросает: отдаёт текст ошибки, а решать, что с ней делать, — вызывающему.
 */

/** Текст ошибки записи; пустое сообщение не должно выглядеть как «ошибки нет». */
const failure = (error: { message: string } | null): string | null => (error ? error.message || 'ошибка записи' : null);

/** Адреса — в глобальный стоп-лист (reason 'unsubscribe'). Повтор безопасен. */
export async function suppressEmails(
  db: SupabaseClient,
  emails: Array<string | null | undefined>,
  note: string,
): Promise<string | null> {
  const unique = [...new Set(emails.map((e) => e?.trim().toLowerCase() ?? '').filter(Boolean))];
  if (!unique.length) return null;
  const { error } = await db
    .from('sender_suppressions')
    .upsert(unique.map((email) => ({ email, reason: 'unsubscribe', note })), { onConflict: 'email' });
  return failure(error);
}

/** Получатель становится 'unsubscribed', следующий шаг цепочки снимается. */
export async function markUnsubscribed(db: SupabaseClient, recipientId: string): Promise<string | null> {
  const { error } = await db
    .from('sender_recipients')
    .update({ status: 'unsubscribed', next_step_at: null, updated_at: new Date().toISOString() })
    .eq('id', recipientId);
  return failure(error);
}

/** Отменяет ещё не отправленные письма лида: после ответа дожимать нельзя. */
export async function cancelPendingMessages(db: SupabaseClient, recipientId: string): Promise<string | null> {
  const { error } = await db
    .from('sender_messages')
    .update({ status: 'canceled' })
    .eq('recipient_id', recipientId)
    .in('status', ['scheduled', 'sending']);
  return failure(error);
}

/**
 * Все три записи подряд — стоп-лист, получатель, очередь писем. Выполняются,
 * даже если одна из них не удалась; отдаётся первая ошибка. Так работает
 * repliesWorker. Кому нужно «сначала стоп-лист, при сбое остановиться» — вызывает
 * шаги по отдельности.
 */
export async function unsubscribeRecipient(
  db: SupabaseClient,
  params: { recipientId: string; emails: Array<string | null | undefined>; note: string },
): Promise<string | null> {
  const errors = [
    await suppressEmails(db, params.emails, params.note),
    await markUnsubscribed(db, params.recipientId),
    await cancelPendingMessages(db, params.recipientId),
  ].filter((e): e is string => Boolean(e));
  return errors[0] ?? null;
}

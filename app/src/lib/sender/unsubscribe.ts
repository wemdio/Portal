import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Просьба больше не писать — общий путь для repliesWorker (стоп-слова в ответе)
 * и ИИ-квалификатора (просьбу понял модель). Работает с переданным клиентом и
 * не бросает: отдаёт текст первой ошибки, а решать, что с ней делать, — вызывающему.
 */

/** Отменяет ещё не отправленные письма лида: после ответа дожимать нельзя. */
export async function cancelPendingMessages(db: SupabaseClient, recipientId: string): Promise<string | null> {
  const { error } = await db
    .from('sender_messages')
    .update({ status: 'canceled' })
    .eq('recipient_id', recipientId)
    .in('status', ['scheduled', 'sending']);
  return error?.message ?? null;
}

/**
 * Адреса уходят в глобальный стоп-лист (reason 'unsubscribe'), получатель
 * становится 'unsubscribed', запланированные письма отменяются. Все три записи
 * выполняются, даже если одна из них не удалась.
 */
export async function unsubscribeRecipient(
  db: SupabaseClient,
  params: { recipientId: string; emails: Array<string | null | undefined>; note: string },
): Promise<string | null> {
  const emails = [...new Set(params.emails.map((e) => e?.trim().toLowerCase() ?? '').filter(Boolean))];
  const errors: string[] = [];
  if (emails.length) {
    const { error } = await db
      .from('sender_suppressions')
      .upsert(emails.map((email) => ({ email, reason: 'unsubscribe', note: params.note })), { onConflict: 'email' });
    if (error) errors.push(error.message);
  }
  const { error: markError } = await db
    .from('sender_recipients')
    .update({ status: 'unsubscribed', next_step_at: null, updated_at: new Date().toISOString() })
    .eq('id', params.recipientId);
  if (markError) errors.push(markError.message);
  const cancelError = await cancelPendingMessages(db, params.recipientId);
  if (cancelError) errors.push(cancelError);
  return errors[0] ?? null;
}

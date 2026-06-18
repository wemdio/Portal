import { supabaseInstantly } from '@/lib/supabaseInstantly';

/**
 * Персональная прочитанность ответов: что КОНКРЕТНЫЙ клиент реально открыл в
 * портале. Источник истины для «непрочитано» вместо общего флага Instantly
 * (email.is_unread), который гасится thread-level пометкой и отправкой ответов.
 * Таблица client_email_reads в Instantly DB (миграция
 * 20260618_0001_client_email_reads).
 */

/** Какие из переданных email_id уже прочитаны этим клиентом. */
export async function getReadEmailIds(
  clientUserId: string,
  emailIds: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!supabaseInstantly || emailIds.length === 0) return out;
  const CHUNK = 200; // email_id уходят в URL фильтра in() — держим запрос компактным
  for (let i = 0; i < emailIds.length; i += CHUNK) {
    const { data } = await supabaseInstantly
      .from('client_email_reads')
      .select('email_id')
      .eq('client_user_id', clientUserId)
      .in('email_id', emailIds.slice(i, i + CHUNK));
    for (const row of (data ?? []) as Array<{ email_id: string }>) out.add(row.email_id);
  }
  return out;
}

/** Пометить письмо прочитанным для клиента (идемпотентно). */
export async function recordEmailRead(clientUserId: string, emailId: string): Promise<void> {
  if (!supabaseInstantly || !emailId) return;
  await supabaseInstantly
    .from('client_email_reads')
    .upsert(
      { client_user_id: clientUserId, email_id: emailId, read_at: new Date().toISOString() },
      { onConflict: 'client_user_id,email_id' },
    );
}

/** Снять отметку «прочитано» (кнопка «пометить непрочитанным»). */
export async function recordEmailUnread(clientUserId: string, emailId: string): Promise<void> {
  if (!supabaseInstantly || !emailId) return;
  await supabaseInstantly
    .from('client_email_reads')
    .delete()
    .eq('client_user_id', clientUserId)
    .eq('email_id', emailId);
}

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Прочитано ли собеседником наше последнее сообщение в диалоге.
 *
 * Telegram отдаёт номер последнего нашего сообщения, которое собеседник
 * прочитал (readOutboxMaxId). Сравниваем его с номером верхнего сообщения
 * чата. Если верхнее сообщение не наше, галочек не нужно, поэтому null.
 */
export function outboxReadFlag(
  lastMessage: { id?: number; out?: boolean } | undefined,
  readOutboxMaxId: number | undefined,
): boolean | null {
  if (!lastMessage?.out) return null;
  if (lastMessage.id == null || readOutboxMaxId == null) return null;
  return readOutboxMaxId >= lastMessage.id;
}

/**
 * Пишет в базу только изменившиеся значения: список диалогов приходит каждый
 * круг, и без сравнения каждый круг переписывал бы сотни строк зря.
 */
export async function syncOutboxReadFlags(
  db: SupabaseClient,
  campaignId: string,
  accountId: string,
  items: { tgUserId: number; flag: boolean | null }[],
): Promise<number> {
  if (items.length === 0) return 0;
  const CHUNK = 200;
  let changed = 0;
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK);
    const { data, error } = await db
      .from('tg_outreach_dialogs')
      .select('id, tg_user_id, out_read')
      .eq('campaign_id', campaignId)
      .eq('account_id', accountId)
      .in('tg_user_id', chunk.map(it => it.tgUserId));
    if (error) throw new Error(error.message);
    const current = new Map<number, { id: string; out_read: boolean | null }>();
    for (const row of (data ?? []) as { id: string; tg_user_id: number | string; out_read: boolean | null }[]) {
      current.set(Number(row.tg_user_id), { id: row.id, out_read: row.out_read });
    }
    for (const it of chunk) {
      const row = current.get(it.tgUserId);
      if (!row || row.out_read === it.flag) continue;
      const { error: upErr } = await db
        .from('tg_outreach_dialogs')
        .update({ out_read: it.flag })
        .eq('id', row.id);
      if (upErr) throw new Error(upErr.message);
      changed++;
    }
  }
  return changed;
}

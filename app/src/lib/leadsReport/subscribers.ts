import type { SupabaseClient } from '@supabase/supabase-js';

export type Subscriber = {
  chat_id: number;
  username: string | null;
  first_name: string | null;
  added_by: number;
  added_at: string;
};

export function getAdminIds(): number[] {
  return Array.from(
    new Set(
      (process.env.LEADS_REPORT_TG_ADMIN_IDS ?? '')
        .split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isSafeInteger(value) && value !== 0),
    ),
  );
}

export function isAdmin(chatId: number): boolean {
  return getAdminIds().includes(chatId);
}

export async function listSubscribers(
  db: SupabaseClient,
): Promise<Subscriber[]> {
  const { data, error } = await db
    .from('leads_report_subscribers')
    .select('*')
    .order('added_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as Subscriber[];
}

export async function addSubscriber(
  db: SupabaseClient,
  chatId: number,
  addedBy: number,
  info: { username?: string; firstName?: string } = {},
): Promise<void> {
  const { error } = await db.from('leads_report_subscribers').upsert(
    {
      chat_id: chatId,
      username: info.username ?? null,
      first_name: info.firstName ?? null,
      added_by: addedBy,
    },
    { onConflict: 'chat_id' },
  );
  if (error) throw error;
}

export async function removeSubscriber(
  db: SupabaseClient,
  chatId: number,
): Promise<boolean> {
  const { error, count } = await db
    .from('leads_report_subscribers')
    .delete({ count: 'exact' })
    .eq('chat_id', chatId);
  if (error) throw error;
  return (count ?? 0) > 0;
}

export async function getAllRecipients(
  db: SupabaseClient,
): Promise<number[]> {
  const subscribers = await listSubscribers(db);
  return Array.from(
    new Set([
      ...getAdminIds(),
      ...subscribers.map((subscriber) => subscriber.chat_id),
    ]),
  );
}

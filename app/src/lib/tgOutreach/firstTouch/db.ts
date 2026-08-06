/**
 * Запросы к таблицам баз. Вынесены из цикла кампании, чтобы `send.ts` читался
 * как последовательность шагов, а не как перемешанные SQL и Telegram.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PendingContact } from './selectContacts';

/** Базы, привязанные к кампании. */
export async function loadCampaignBaseIds(
  db: SupabaseClient,
  campaignId: string,
): Promise<string[]> {
  const { data } = await db
    .from('tg_outreach_campaign_bases')
    .select('base_id')
    .eq('campaign_id', campaignId)
    .limit(500);
  return (data ?? []).map((r) => (r as { base_id: string }).base_id);
}

/**
 * Ожидающие контакты по каждой базе.
 *
 * Берём с запасом (`perBaseLimit`), потому что часть отсеется на дедупе и
 * резолве юзернейма, а ходить в базу второй раз за добором дороже.
 */
export async function loadPendingByBase(
  db: SupabaseClient,
  baseIds: string[],
  perBaseLimit: number,
): Promise<Array<{ baseId: string; contacts: PendingContact[] }>> {
  const out: Array<{ baseId: string; contacts: PendingContact[] }> = [];
  for (const baseId of baseIds) {
    const { data } = await db
      .from('tg_outreach_base_contacts')
      .select('id, base_id, username, message')
      .eq('base_id', baseId)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(perBaseLimit);
    out.push({ baseId, contacts: (data ?? []) as PendingContact[] });
  }
  return out;
}

/** Сколько первых сообщений аккаунт отправил с начала суток. */
export async function countSentToday(
  db: SupabaseClient,
  accountId: string,
  since: Date,
): Promise<number> {
  const { count } = await db
    .from('tg_outreach_base_contacts')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .gte('sent_at', since.toISOString());
  return count ?? 0;
}

export async function markContactSent(
  db: SupabaseClient,
  contactId: string,
  accountId: string,
  tgUserId: number,
): Promise<void> {
  await db
    .from('tg_outreach_base_contacts')
    .update({
      status: 'sent',
      account_id: accountId,
      tg_user_id: tgUserId,
      sent_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', contactId);
}

export async function markContactSkipped(
  db: SupabaseClient,
  contactId: string,
  reason: string,
): Promise<void> {
  await db
    .from('tg_outreach_base_contacts')
    .update({ status: 'skipped', skip_reason: reason, updated_at: new Date().toISOString() })
    .eq('id', contactId);
}

/**
 * Неудачная попытка: контакт не сгорает, а откладывается до следующего круга —
 * сбой мог быть сетевым. Три подряд — сдаёмся и показываем оператору.
 */
export async function recordContactFailure(
  db: SupabaseClient,
  contactId: string,
  attempts: number,
  reason: string,
): Promise<void> {
  const next = attempts + 1;
  await db
    .from('tg_outreach_base_contacts')
    .update({
      attempts: next,
      skip_reason: reason,
      ...(next >= 3 ? { status: 'failed' } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('id', contactId);
}

/**
 * Аккаунты кампании: несколько на кампанию, один аккаунт — одна кампания.
 *
 * Основной аккаунт (первый в списке) дублируется в li_campaigns.account_id:
 * на нём держатся старые кампании, воркер и экран аккаунтов.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

interface CampaignAccountRow {
  account_id: string;
  position: number;
}

/** Аккаунты кампании по порядку; у старой кампании без строк — один основной. */
export async function loadCampaignAccountIds(
  db: SupabaseClient,
  campaignId: string,
  primaryAccountId: string | null,
): Promise<string[]> {
  const { data } = await db
    .from('li_campaign_accounts')
    .select('account_id, position')
    .eq('campaign_id', campaignId)
    .order('position', { ascending: true });
  const ids = ((data ?? []) as CampaignAccountRow[]).map((r) => r.account_id);
  if (ids.length > 0) return ids;
  return primaryAccountId ? [primaryAccountId] : [];
}

/**
 * Сохранить список аккаунтов кампании. Возвращает текст ошибки, если какой-то
 * аккаунт уже занят другой кампанией. Занятость проверяем только для
 * добавляемых: у старых данных аккаунт мог стоять в двух кампаниях, и это не
 * повод не сохранить текущую.
 */
export async function saveCampaignAccounts(
  db: SupabaseClient,
  campaignId: string,
  accountIds: string[],
): Promise<string | null> {
  const unique = Array.from(new Set(accountIds.filter((v) => typeof v === 'string' && v)));

  const { data: self } = await db.from('li_campaigns').select('account_id').eq('id', campaignId).maybeSingle();
  const primary = (self as { account_id?: string | null } | null)?.account_id ?? null;
  const alreadyHere = new Set(await loadCampaignAccountIds(db, campaignId, primary));

  for (const accountId of unique) {
    if (alreadyHere.has(accountId)) continue;
    const { data: byColumn } = await db
      .from('li_campaigns').select('id, name').eq('account_id', accountId).neq('id', campaignId).limit(1);
    const { data: byTable } = await db
      .from('li_campaign_accounts').select('campaign_id').eq('account_id', accountId).neq('campaign_id', campaignId).limit(1);
    const busy = (byColumn ?? [])[0] as { name?: string } | undefined;
    if (busy || (byTable ?? []).length > 0) {
      return busy?.name
        ? `Аккаунт уже занят кампанией «${busy.name}» — один аккаунт можно использовать только в одной кампании.`
        : 'Аккаунт уже занят другой кампанией — один аккаунт можно использовать только в одной кампании.';
    }
  }

  const { error: delError } = await db.from('li_campaign_accounts').delete().eq('campaign_id', campaignId);
  if (delError) return delError.message;
  if (unique.length > 0) {
    const { error: insError } = await db
      .from('li_campaign_accounts')
      .insert(unique.map((account_id, position) => ({ campaign_id: campaignId, account_id, position })));
    if (insError) return insError.message;
  }
  const { error: updError } = await db
    .from('li_campaigns')
    .update({ account_id: unique[0] ?? null, updated_at: new Date().toISOString() })
    .eq('id', campaignId);
  if (updError) return updError.message;

  // Лиды снятых аккаунтов вернутся в общий пул — воркер распределит их заново.
  if (unique.length > 0) {
    await db
      .from('li_campaign_leads')
      .update({ account_id: null })
      .eq('campaign_id', campaignId)
      .not('account_id', 'in', `(${unique.join(',')})`);
  }
  return null;
}

/**
 * Распределить лидов без аккаунта поровну между аккаунтами кампании: каждый
 * следующий достаётся тому, у кого сейчас меньше всего лидов.
 */
export async function assignUnassignedLeads(
  db: SupabaseClient,
  campaignId: string,
  accountIds: string[],
): Promise<number> {
  if (accountIds.length < 2) return 0;
  const { data: unassigned } = await db
    .from('li_campaign_leads')
    .select('id, status, current_step')
    .eq('campaign_id', campaignId)
    .is('account_id', null)
    .limit(5000);
  const rows = (unassigned ?? []) as Array<{ id: string; status: string; current_step: number }>;
  if (rows.length === 0) return 0;

  // Кого уже начали обрабатывать (инвайт ушёл, чат открыт), оставляем на
  // основном аккаунте: диалог и приглашение привязаны к тому, кто их отправил.
  const started = rows.filter((r) => r.status !== 'pending' || r.current_step > 0).map((r) => r.id);
  for (let i = 0; i < started.length; i += 200) {
    await db.from('li_campaign_leads').update({ account_id: accountIds[0] }).in('id', started.slice(i, i + 200));
  }
  const ids = rows.filter((r) => r.status === 'pending' && r.current_step === 0).map((r) => r.id);
  if (ids.length === 0) return rows.length;

  const counts = new Map<string, number>();
  for (const accountId of accountIds) {
    const { count } = await db
      .from('li_campaign_leads')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', campaignId)
      .eq('account_id', accountId);
    counts.set(accountId, count ?? 0);
  }

  const buckets = new Map<string, string[]>(accountIds.map((a) => [a, []]));
  for (const id of ids) {
    let best = accountIds[0];
    for (const a of accountIds) if ((counts.get(a) ?? 0) < (counts.get(best) ?? 0)) best = a;
    buckets.get(best)!.push(id);
    counts.set(best, (counts.get(best) ?? 0) + 1);
  }
  for (const [accountId, leadIds] of buckets) {
    for (let i = 0; i < leadIds.length; i += 200) {
      await db.from('li_campaign_leads').update({ account_id: accountId }).in('id', leadIds.slice(i, i + 200));
    }
  }
  return rows.length;
}

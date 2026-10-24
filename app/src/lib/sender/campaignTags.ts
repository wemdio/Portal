import { supabaseAdmin } from '@/lib/supabaseAdmin';

/**
 * Кампания, привязанная к тегу ящиков целиком (sender_campaign_tags).
 *
 * Выбрали тег в окне ящиков — кампания получает не только его ящики на этот
 * момент, а сам тег: попали под тег новые ящики, они доливаются в идущую
 * кампанию без остановки и повторного выбора.
 *
 * Только добавляем. Ящик, ушедший из тега, из кампании не убирается: ответы
 * приходят на тот ящик, с которого ушло письмо, и отбирать его на полпути
 * нельзя (так же устроены ящики папки, lib/sender/folders.ts).
 */

/** Идущие и поставленные на паузу: черновик и так возьмёт ящики при запуске. */
const LIVE_CAMPAIGN_STATUSES = ['running', 'paused'];
const CHUNK = 200;
const TAG_MAILBOX_PAGE = 1000;

/** Теги, к которым привязана кампания. */
export async function loadCampaignTagIds(campaignId: string): Promise<string[]> {
  if (!supabaseAdmin) return [];
  const { data } = await supabaseAdmin.from('sender_campaign_tags').select('tag_id').eq('campaign_id', campaignId);
  return (data ?? []).map((row) => String(row.tag_id));
}

/** Привязка кампании к тегам переписывается целиком: набор маленький. */
export async function saveCampaignTags(campaignId: string, tagIds: string[]): Promise<void> {
  if (!supabaseAdmin) return;
  const unique = [...new Set(tagIds.filter((id) => typeof id === 'string' && id))];
  await supabaseAdmin.from('sender_campaign_tags').delete().eq('campaign_id', campaignId);
  if (!unique.length) return;
  const { error } = await supabaseAdmin
    .from('sender_campaign_tags')
    .insert(unique.map((tagId) => ({ campaign_id: campaignId, tag_id: tagId })));
  if (error) throw new Error(error.message);
}

async function upsertPool(campaignIds: string[], mailboxIds: string[]): Promise<void> {
  if (!supabaseAdmin || !campaignIds.length || !mailboxIds.length) return;
  const rows = campaignIds.flatMap((campaignId) =>
    mailboxIds.map((mailboxId) => ({ campaign_id: campaignId, mailbox_id: mailboxId })),
  );
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabaseAdmin
      .from('sender_campaign_mailboxes')
      .upsert(rows.slice(i, i + CHUNK), { onConflict: 'campaign_id,mailbox_id', ignoreDuplicates: true });
    if (error) throw new Error(error.message);
  }
}

/**
 * Ящики попали под тег — доливаем их в идущие кампании, привязанные к тегу.
 * Возвращает, сколько кампаний их получило.
 */
export async function addTagMailboxesToLiveCampaigns(tagId: string, mailboxIds: string[]): Promise<number> {
  if (!supabaseAdmin || !mailboxIds.length) return 0;
  const { data: links } = await supabaseAdmin.from('sender_campaign_tags').select('campaign_id').eq('tag_id', tagId);
  const linked = (links ?? []).map((row) => String(row.campaign_id));
  if (!linked.length) return 0;
  const { data: live } = await supabaseAdmin
    .from('sender_campaigns')
    .select('id')
    .in('id', linked)
    .in('status', LIVE_CAMPAIGN_STATUSES);
  const campaignIds = (live ?? []).map((row) => String(row.id));
  await upsertPool(campaignIds, mailboxIds);
  return campaignIds.length;
}

/**
 * При запуске: ящики, добавленные под тег, пока кампания стояла, догоняют её
 * пул. Возвращает число ящиков тегов кампании.
 */
export async function syncCampaignTagMailboxes(campaignId: string): Promise<number> {
  if (!supabaseAdmin) return 0;
  const tagIds = await loadCampaignTagIds(campaignId);
  if (!tagIds.length) return 0;
  const ids: string[] = [];
  for (let from = 0; ; from += TAG_MAILBOX_PAGE) {
    const { data, error } = await supabaseAdmin
      .from('sender_mailboxes')
      .select('id')
      .in('tag_id', tagIds)
      .order('id')
      .range(from, from + TAG_MAILBOX_PAGE - 1);
    if (error) throw new Error(error.message);
    ids.push(...(data ?? []).map((row) => String(row.id)));
    if ((data?.length ?? 0) < TAG_MAILBOX_PAGE) break;
  }
  await upsertPool([campaignId], ids);
  return ids.length;
}

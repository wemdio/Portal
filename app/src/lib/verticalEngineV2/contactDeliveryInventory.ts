import type { SupabaseClient } from '@supabase/supabase-js';

const PAGE_SIZE = 500;
const ID_BATCH_SIZE = 100;

type Page<T> = {
  data: T[] | null;
  count?: number | null;
  error: { message: string } | null;
};

export async function readContactDeliveryPages<T>(
  label: string,
  read: (from: number, to: number) => PromiseLike<Page<T>>,
): Promise<T[]> {
  const rows: T[] = [];
  let total: number | null = null;
  while (total === null || rows.length < total) {
    const page = await read(rows.length, rows.length + PAGE_SIZE - 1);
    if (page.error) throw new Error(`${label} read failed: ${page.error.message}`);
    if (!Number.isSafeInteger(page.count) || (page.count ?? -1) < 0) {
      throw new Error(`${label} exact row count is unavailable`);
    }
    if (total !== null && page.count !== total) {
      throw new Error(`${label} changed during pagination`);
    }
    total = page.count as number;
    if (!Array.isArray(page.data) || (page.data.length === 0 && rows.length < total)) {
      throw new Error(`${label} pagination ended before completion`);
    }
    rows.push(...page.data);
    if (rows.length > total) throw new Error(`${label} pagination exceeded its exact count`);
  }
  return rows;
}

function exactContactCount(value: unknown): number | null {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

/**
 * All campaign history matters when distinguishing delivered-but-not-contacted
 * supply from the Portal period's fulfillment fact. A released bundle must not
 * disappear from that calculation. Missing catalog rows conservatively count
 * as zero; present but malformed facts fail closed instead of inflating room.
 */
export async function loadVeContactDeliveryCampaignInventory(
  portalDb: SupabaseClient,
  instantlyDb: SupabaseClient,
  veProjectId: string,
): Promise<{
  allCampaignIds: string[];
  activeCampaignIds: string[];
  activeCampaignRowIds: string[];
  observedFirstContacted: number;
}> {
  const items = await readContactDeliveryPages<{ id: string; status: string }>(
    'delivery queue inventory',
    (from, to) => portalDb
      .from('ve_launch_queue_items')
      .select('id, status', { count: 'exact' })
      .eq('project_id', veProjectId)
      .order('id', { ascending: true })
      .range(from, to),
  );
  const itemIds = items.map((item) => item.id);
  if (itemIds.some((id) => typeof id !== 'string' || !id) || new Set(itemIds).size !== itemIds.length) {
    throw new Error('delivery queue inventory has invalid or duplicate identities');
  }
  const activeItems = new Set(items.filter((item) => item.status === 'active').map((item) => item.id));
  const activeItemsWithCampaigns = new Set<string>();
  const allIds = new Set<string>();
  const activeIds = new Set<string>();
  const activeCampaignRowIds = new Set<string>();
  const childIds = new Set<string>();
  for (let offset = 0; offset < itemIds.length; offset += ID_BATCH_SIZE) {
    const ids = itemIds.slice(offset, offset + ID_BATCH_SIZE);
    const campaigns = await readContactDeliveryPages<{ id: string; item_id: string; campaign_id: string }>(
      'delivery campaign inventory',
      (from, to) => portalDb
        .from('ve_launch_queue_campaigns')
        .select('id, item_id, campaign_id', { count: 'exact' })
        .in('item_id', ids)
        .order('id', { ascending: true })
        .range(from, to),
    );
    for (const campaign of campaigns) {
      if (
        !ids.includes(campaign.item_id) || !campaign.id || childIds.has(campaign.id)
        || typeof campaign.campaign_id !== 'string' || !campaign.campaign_id.trim()
      ) {
        throw new Error('delivery campaign inventory has invalid or duplicate identities');
      }
      childIds.add(campaign.id);
      allIds.add(campaign.campaign_id);
      if (activeItems.has(campaign.item_id)) {
        activeCampaignRowIds.add(campaign.id);
        activeIds.add(campaign.campaign_id);
        activeItemsWithCampaigns.add(campaign.item_id);
      }
    }
  }
  if ([...activeItems].some((id) => !activeItemsWithCampaigns.has(id))) {
    throw new Error('active launch bundle has no campaign children');
  }

  const allCampaignIds = [...allIds].sort();
  let observedFirstContacted = 0;
  const observedIds = new Set<string>();
  for (let offset = 0; offset < allCampaignIds.length; offset += ID_BATCH_SIZE) {
    const ids = allCampaignIds.slice(offset, offset + ID_BATCH_SIZE);
    const catalog = await readContactDeliveryPages<{ id: string; new_leads_contacted_count: unknown }>(
      'delivery campaign first-contacted inventory',
      (from, to) => instantlyDb
        .from('instantly_campaign_catalog')
        .select('id, new_leads_contacted_count', { count: 'exact' })
        .in('id', ids)
        .order('id', { ascending: true })
        .range(from, to),
    );
    for (const campaign of catalog) {
      const contacts = exactContactCount(campaign.new_leads_contacted_count);
      if (contacts === null) {
        throw new Error('delivery catalog requires an exact non-negative first-contacted count');
      }
      if (!ids.includes(campaign.id) || observedIds.has(campaign.id)) {
        throw new Error('delivery catalog has invalid or duplicate campaign identities');
      }
      observedIds.add(campaign.id);
      observedFirstContacted += contacts;
      if (!Number.isSafeInteger(observedFirstContacted)) {
        throw new Error('delivery first-contacted total exceeds the safe integer range');
      }
    }
  }
  return { allCampaignIds, activeCampaignIds: [...activeIds].sort(), activeCampaignRowIds: [...activeCampaignRowIds], observedFirstContacted };
}

export type ContactDeliveryInventoryRow = {
  id: string;
  campaign_row_id: string;
  email_normalized: string;
  status: 'ready' | 'reserved' | 'attempting' | 'accepted' | 'skipped' | 'uncertain';
};

export async function loadVeContactDeliveryRows(db: SupabaseClient, veProjectId: string) {
  const rows = await readContactDeliveryPages<ContactDeliveryInventoryRow>(
    'delivery contact reserve',
    (from, to) => db.from('ve_contact_delivery_rows')
      .select('id, campaign_row_id, email_normalized, status', { count: 'exact' })
      .eq('ve_project_id', veProjectId)
      .order('id', { ascending: true })
      .range(from, to),
  );
  if (new Set(rows.map((row) => row.id)).size !== rows.length
    || new Set(rows.map((row) => row.email_normalized)).size !== rows.length) {
    throw new Error('delivery reserve changed during pagination');
  }
  return rows;
}

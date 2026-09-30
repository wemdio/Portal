import type { SupabaseClient } from '@supabase/supabase-js';
import { CampaignStatus } from '@/lib/instantly/types';
import { getCampaign, getCampaignAnalyticsOverview } from '@/lib/instantly/client';

const PAGE_SIZE = 500;
const ID_BATCH_SIZE = 100;

export class ContactDeliveryAnalyticsUnavailableError extends Error {
  constructor() {
    super('delivery catalog requires an exact non-negative first-contacted count');
    this.name = 'ContactDeliveryAnalyticsUnavailableError';
  }
}

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

/** A campaign without its first send may be absent from /campaigns/analytics.
 * The scoped overview still returns explicit counters. Verify the campaign in
 * its immutable workspace first: an unscoped overview would count other runs.
 * No catalog writes here; this path is also used by read-only previews.
 */
async function readMissingCampaignCount(campaignId: string, accountId: unknown): Promise<number> {
  if (typeof accountId !== 'string' || !accountId.trim()) throw new ContactDeliveryAnalyticsUnavailableError();
  try {
    const options = { accountId };
    const campaign = await getCampaign(campaignId, options);
    if (campaign?.id !== campaignId) throw new ContactDeliveryAnalyticsUnavailableError();
    const overview = await getCampaignAnalyticsOverview({ campaign_id: campaignId }, options);
    const count = overview?.new_leads_contacted_count;
    const sent = overview?.emails_sent_count;
    if (typeof count !== 'number' || exactContactCount(count) === null
      || typeof sent !== 'number' || exactContactCount(sent) === null || count > sent) {
      throw new ContactDeliveryAnalyticsUnavailableError();
    }
    return count;
  } catch {
    throw new ContactDeliveryAnalyticsUnavailableError();
  }
}

/**
 * All campaign history matters when distinguishing delivered-but-not-contacted
 * supply from the Portal period's fulfillment fact. A released bundle must not
 * disappear from that calculation. Missing analytics require a scoped provider
 * read. An explicit initial null is allowed only for an empty campaign that
 * has not been activated and was observed as draft/paused. Previously delivered
 * campaigns and malformed or incomplete synced facts still fail closed.
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
  const items = await readContactDeliveryPages<{ id: string; status: string; instantly_account_id?: string }>(
    'delivery queue inventory',
    (from, to) => portalDb
      .from('ve_launch_queue_items')
      .select('id, status, instantly_account_id', { count: 'exact' })
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
  const initialEmptyCampaignIds = new Set<string>();
  const childIds = new Set<string>();
  const campaignAccounts = new Map<string, string | undefined>();
  const itemAccounts = new Map(items.map(item => [item.id, item.instantly_account_id]));
  for (let offset = 0; offset < itemIds.length; offset += ID_BATCH_SIZE) {
    const ids = itemIds.slice(offset, offset + ID_BATCH_SIZE);
    const campaigns = await readContactDeliveryPages<{
      id: string; item_id: string; campaign_id: string; leads_count: unknown;
      activated_at: unknown; remote_status: unknown; status_observed_at: unknown;
    }>(
      'delivery campaign inventory',
      (from, to) => portalDb
        .from('ve_launch_queue_campaigns')
        .select('id, item_id, campaign_id, leads_count, activated_at, remote_status, status_observed_at', { count: 'exact' })
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
      if (allIds.has(campaign.campaign_id)) throw new Error('delivery campaign identity belongs to multiple launch rows');
      allIds.add(campaign.campaign_id);
      campaignAccounts.set(campaign.campaign_id, itemAccounts.get(campaign.item_id));
      if (campaign.leads_count === 0 && campaign.activated_at === null &&
        (campaign.remote_status === CampaignStatus.Draft || campaign.remote_status === CampaignStatus.Paused) &&
        typeof campaign.status_observed_at === 'string' && Number.isFinite(Date.parse(campaign.status_observed_at))) {
        initialEmptyCampaignIds.add(campaign.campaign_id);
      }
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
    const catalog = await readContactDeliveryPages<{
      id: string; new_leads_contacted_count: unknown; analytics_synced_at: unknown;
    }>(
      'delivery campaign first-contacted inventory',
      (from, to) => instantlyDb
        .from('instantly_campaign_catalog')
        .select('id, new_leads_contacted_count, analytics_synced_at', { count: 'exact' })
        .in('id', ids)
        .order('id', { ascending: true })
        .range(from, to),
    );
    for (const campaign of catalog) {
      // The catalog sync creates a row before the separate analytics sync.
      // Do not make an unknown count in an already delivered campaign look empty.
      const awaitingFirstAnalytics = campaign.new_leads_contacted_count === null &&
        campaign.analytics_synced_at === null && initialEmptyCampaignIds.has(campaign.id);
      const contacts = awaitingFirstAnalytics ? 0
        : campaign.new_leads_contacted_count == null
          ? await readMissingCampaignCount(campaign.id, campaignAccounts.get(campaign.id))
          : exactContactCount(campaign.new_leads_contacted_count);
      if (contacts === null) {
        throw new ContactDeliveryAnalyticsUnavailableError();
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
    for (const id of ids.filter(id => !observedIds.has(id))) {
      observedFirstContacted += await readMissingCampaignCount(id, campaignAccounts.get(id));
      if (!Number.isSafeInteger(observedFirstContacted)) throw new Error('delivery first-contacted total exceeds the safe integer range');
      observedIds.add(id);
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

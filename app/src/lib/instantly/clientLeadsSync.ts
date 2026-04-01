import 'server-only';

import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { listAllLeads, listAllCampaigns } from '@/lib/instantly/client';

const BATCH_SIZE = 500;
const CONCURRENCY = 3;

interface AccessRow {
  client_user_id: string;
  resource_id: string;
}

/**
 * Syncs leads from Instantly API into client_campaign_leads for ALL client users.
 * Designed to run in the background worker on an hourly schedule.
 *
 * Fetches leads once per unique campaign (not per user) to minimize API calls,
 * then upserts for each user that has access to that campaign.
 */
export async function syncClientLeads(): Promise<{ campaigns: number; leads: number }> {
  if (!supabaseInstantly) {
    throw new Error('INSTANTLY_SUPABASE not configured — client leads sync unavailable');
  }
  const db = supabaseInstantly;

  const { data: accessRows, error: accessErr } = await db
    .from('client_instantly_access')
    .select('client_user_id, resource_id')
    .eq('resource_type', 'campaign');

  if (accessErr) throw new Error(`Failed to read client_instantly_access: ${accessErr.message}`);
  if (!accessRows?.length) return { campaigns: 0, leads: 0 };

  const campaignUsers = new Map<string, string[]>();
  for (const row of accessRows as AccessRow[]) {
    let users = campaignUsers.get(row.resource_id);
    if (!users) {
      users = [];
      campaignUsers.set(row.resource_id, users);
    }
    users.push(row.client_user_id);
  }

  const campaignNames = await listAllCampaigns();
  const nameMap = new Map(campaignNames.map((c) => [c.id, c.name]));

  let totalLeads = 0;
  let campaignsDone = 0;

  const syncOneCampaign = async (campaignId: string, userIds: string[]) => {
    const campaignName = nameMap.get(campaignId) ?? campaignId;

    const rawLeads = await listAllLeads(campaignId);
    if (rawLeads.length === 0) {
      console.log(`[leads-sync] "${campaignName}" — 0 leads from Instantly`);
      campaignsDone++;
      await updateSyncTimestamp(db, campaignId, userIds);
      return;
    }

    console.log(`[leads-sync] "${campaignName}" — ${rawLeads.length} leads, upserting for ${userIds.length} user(s)`);

    const now = new Date().toISOString();

    for (const userId of userIds) {
      const rows = rawLeads.map((l) => ({
        client_user_id: userId,
        campaign_id: campaignId,
        email: l.email,
        first_name: l.first_name ?? null,
        last_name: l.last_name ?? null,
        company_name: l.company_name ?? null,
        website: l.website ?? null,
        linkedin_url: l.linkedin_url ?? null,
        synced_at: now,
      }));

      for (let j = 0; j < rows.length; j += BATCH_SIZE) {
        const { error } = await db
          .from('client_campaign_leads')
          .upsert(rows.slice(j, j + BATCH_SIZE), {
            onConflict: 'client_user_id,campaign_id,email',
            ignoreDuplicates: false,
          });
        if (error) {
          console.error(`[leads-sync] upsert error for "${campaignName}" user=${userId}:`, error.message);
        }
      }
    }

    totalLeads += rawLeads.length;
    campaignsDone++;
    await updateSyncTimestamp(db, campaignId, userIds);
  };

  const entries = [...campaignUsers.entries()];
  const executing = new Set<Promise<void>>();
  for (const [campaignId, userIds] of entries) {
    const task = syncOneCampaign(campaignId, userIds).finally(() => executing.delete(task));
    executing.add(task);
    if (executing.size >= CONCURRENCY) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);

  console.log(`[leads-sync] done: ${campaignsDone} campaigns, ${totalLeads} total leads`);
  return { campaigns: campaignsDone, leads: totalLeads };
}

async function updateSyncTimestamp(
  db: NonNullable<typeof supabaseInstantly>,
  campaignId: string,
  userIds: string[],
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await db
    .from('client_instantly_access')
    .update({ leads_synced_at: now })
    .eq('resource_type', 'campaign')
    .eq('resource_id', campaignId)
    .in('client_user_id', userIds);
  if (error) {
    console.error(`[leads-sync] failed to update leads_synced_at for campaign ${campaignId}:`, error.message);
  }
}

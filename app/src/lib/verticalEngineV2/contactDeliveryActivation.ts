import type { SupabaseClient } from '@supabase/supabase-js';
import { getCampaign } from '@/lib/instantly/client';
import { readContactDeliveryPages } from './contactDeliveryInventory';
import { launchMailboxScopesEqual } from './launchPortfolio';

/** Compatibility for older internal callers: sending is always started in Instantly. */
export async function activateApprovedLaunchCampaigns(input: {
  portalDb: SupabaseClient; veProjectId: string; accountId: string; campaignIds: string[];
}): Promise<{ deferred: boolean }> {
  const {data: project, error} = await input.portalDb.from('ve_projects')
    .select('portal_project_id, portal_period_id, target_contacts').eq('id', input.veProjectId).maybeSingle();
  if (error || !project) throw new Error('Не удалось проверить план загрузки перед активацией.');
  if ((project.portal_project_id || project.portal_period_id || project.target_contacts != null) &&
      (!project.portal_project_id || !Number.isSafeInteger(project.target_contacts) || project.target_contacts <= 0)) {
    throw new Error('Привязка плана ежедневной загрузки неполна.');
  }
  return {deferred: true};
}

/**
 * Observe manual Start/Pause in Instantly; never call the activation API.
 * Retains its old export/result shape for worker compatibility. `activated`
 * is always zero: recording a provider state is not starting a campaign.
 */
export async function activateDeliveredContactCampaigns(input: {
  portalDb: SupabaseClient; veProjectId: string; itemId?: string;
}): Promise<{ activated: number; errors: string[] }> {
  const items = await readContactDeliveryPages<{id: string; instantly_account_id: string; mailbox_ids: string[]}>(
    'manual campaign state items', (from, to) => {
      let query = input.portalDb.from('ve_launch_queue_items')
        .select('id, instantly_account_id, mailbox_ids', {count: 'exact'})
        .eq('project_id', input.veProjectId).in('status', ['prepared','queued','active','uncertain']);
      if (input.itemId) query = query.eq('id', input.itemId);
      return query.order('id', {ascending: true}).range(from, to);
    });
  const errors: string[] = [];
  for (const item of items) {
    try {
      const campaigns = await readContactDeliveryPages<{id: string; campaign_id: string}>(
        'manual campaign state children', (from, to) => input.portalDb.from('ve_launch_queue_campaigns')
          .select('id, campaign_id', {count: 'exact'}).eq('item_id', item.id)
          .order('id', {ascending: true}).range(from, to));
      if (!campaigns.length) throw new Error('Prepared launch has no campaign children');
      const observations = [];
      for (const campaign of campaigns) {
        const live = await getCampaign(campaign.campaign_id, {accountId: item.instantly_account_id,
          timeoutMs: 10_000, timeoutIncludesBody: true, retryRateLimits: false});
        if (live.id !== campaign.campaign_id || !launchMailboxScopesEqual(live.email_list, item.mailbox_ids) || live.email_tag_list?.length) {
          throw new Error('Live campaign identity or sender scope changed');
        }
        observations.push({campaign_id: live.id, status: live.status, status_observed_at: new Date().toISOString()});
      }
      const {data, error} = await input.portalDb.rpc('ve_observe_manual_campaigns', {
        p_item_id: item.id, p_campaigns: observations, p_now: new Date().toISOString(),
      });
      if (error || data?.observed !== true) throw new Error(error?.message ?? 'Campaign observation was rejected');
    } catch (error) {
      errors.push(`${item.id}: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`);
    }
  }
  return {activated: 0, errors};
}

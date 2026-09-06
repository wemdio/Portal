import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { activateCampaign, getCampaign } from '@/lib/instantly/client';
import { CampaignStatus } from '@/lib/instantly/types';
import { readContactDeliveryPages } from './contactDeliveryInventory';
import { launchMailboxScopesEqual } from './launchPortfolio';

/** Approval owns the slot; a bound empty campaign starts only after its first tranche. */
export async function activateApprovedLaunchCampaigns(input: {
  portalDb: SupabaseClient;
  veProjectId: string;
  accountId: string;
  campaignIds: string[];
}): Promise<{ deferred: boolean }> {
  const { data: project, error } = await input.portalDb.from('ve_projects')
    .select('portal_project_id, portal_period_id, target_contacts')
    .eq('id', input.veProjectId).maybeSingle();
  if (error || !project) throw new Error('Не удалось проверить план загрузки перед активацией.');
  if (project.portal_project_id || project.portal_period_id || project.target_contacts != null) {
    if (!project.portal_project_id || !project.portal_period_id ||
        !Number.isSafeInteger(project.target_contacts) || project.target_contacts <= 0) {
      throw new Error('Привязка плана ежедневной загрузки неполна.');
    }
    return { deferred: true };
  }
  for (const campaignId of input.campaignIds) await activateCampaign(campaignId, { accountId: input.accountId });
  return { deferred: false };
}

type ActiveItem = { id: string; instantly_account_id: string; mailbox_ids: string[] };
type DeliveryCampaign = { id: string; item_id: string; campaign_id: string; leads_count: number; activated_at: string | null };
type UnresolvedActivation = { id: string; item_id: string; campaign_id: string };

function objectResult(data: unknown): Record<string, unknown> | null {
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === 'object' ? row as Record<string, unknown> : null;
}

/**
 * Starts accepted tranches, never empty campaigns. Each external activation is
 * fenced by a durable attempt tied to the accepted-count watermark. A timeout
 * is reconciled only from a later live active status, never blindly retried.
 */
export async function activateDeliveredContactCampaigns(input: {
  portalDb: SupabaseClient;
  veProjectId: string;
}): Promise<{ activated: number; errors: string[] }> {
  const items = await readContactDeliveryPages<ActiveItem>('delivery activation items', (from, to) =>
    input.portalDb.from('ve_launch_queue_items')
      .select('id, instantly_account_id, mailbox_ids', { count: 'exact' })
      .eq('project_id', input.veProjectId).eq('status', 'active')
      .order('id', { ascending: true }).range(from, to));
  let activated = 0;
  const errors: string[] = [];
  for (const item of items) {
    const [campaigns, unresolved] = await Promise.all([
      readContactDeliveryPages<DeliveryCampaign>('delivery activation campaigns', (from, to) =>
        input.portalDb.from('ve_launch_queue_campaigns')
          .select('id, item_id, campaign_id, leads_count, activated_at', { count: 'exact' })
          .eq('item_id', item.id).order('id', { ascending: true }).range(from, to)),
      readContactDeliveryPages<UnresolvedActivation>('delivery activation attempts', (from, to) =>
        input.portalDb.from('ve_contact_delivery_activation_attempts')
          .select('id, item_id, campaign_id', { count: 'exact' })
          .eq('item_id', item.id).in('status', ['attempting', 'uncertain'])
          .order('id', { ascending: true }).range(from, to)),
    ]);
    for (const campaign of campaigns) {
      if (!Number.isSafeInteger(campaign.leads_count) || campaign.leads_count <= 0) continue;
      const options = { accountId: item.instantly_account_id, timeoutMs: 10_000, retryRateLimits: false };
      let attemptId: string | null = null;
      try {
        const live = await getCampaign(campaign.campaign_id, options);
        const observedAt = new Date().toISOString();
        if (live.id !== campaign.campaign_id || !launchMailboxScopesEqual(live.email_list, item.mailbox_ids)) {
          throw new Error('Live campaign identity or sender scope changed');
        }
        const pending = unresolved.filter((attempt) => attempt.campaign_id === campaign.campaign_id);
        if (pending.length > 1) throw new Error('Multiple unresolved activation attempts');
        if (pending.length === 1) {
          // A previous call may have succeeded remotely. Only live evidence can
          // upgrade that exact attempt; paused/manual states stay untouched.
          if (live.status !== CampaignStatus.Active && live.status !== CampaignStatus.RunningSubsequences) continue;
          attemptId = pending[0].id;
        } else {
          const firstStart = !campaign.activated_at &&
            (live.status === CampaignStatus.Draft || live.status === CampaignStatus.Paused);
          if (!firstStart && live.status !== CampaignStatus.Completed) continue;
          attemptId = randomUUID();
          const { data, error } = await input.portalDb.rpc('ve_reserve_contact_delivery_activation', {
            p_item_id: item.id, p_campaign_id: campaign.campaign_id, p_attempt_id: attemptId,
            p_remote_status: live.status, p_status_observed_at: observedAt, p_now: observedAt,
          });
          if (error) throw new Error(error.message);
          if (objectResult(data)?.reserved !== true) { attemptId = null; continue; }
          await activateCampaign(campaign.campaign_id, options);
          const confirmed = await getCampaign(campaign.campaign_id, options);
          if (confirmed.id !== campaign.campaign_id ||
              !launchMailboxScopesEqual(confirmed.email_list, item.mailbox_ids) ||
              (confirmed.status !== CampaignStatus.Active && confirmed.status !== CampaignStatus.RunningSubsequences)) {
            throw new Error('Activation did not return a verified live sending state');
          }
        }
        const { data, error } = await input.portalDb.rpc('ve_finalize_contact_delivery_activation', {
          p_item_id: item.id, p_campaign_id: campaign.campaign_id, p_attempt_id: attemptId,
          p_succeeded: true, p_error: null, p_now: new Date().toISOString(),
        });
        if (error || objectResult(data)?.finalized !== true) throw new Error(error?.message ?? 'Activation finalization was rejected');
        activated += 1;
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
        errors.push(`${campaign.campaign_id}: ${message}`);
        if (attemptId) {
          const { error: finalizeError } = await input.portalDb.rpc('ve_finalize_contact_delivery_activation', {
            p_item_id: item.id, p_campaign_id: campaign.campaign_id, p_attempt_id: attemptId,
            p_succeeded: false, p_error: message, p_now: new Date().toISOString(),
          });
          if (finalizeError) errors.push(`${campaign.campaign_id}: ${finalizeError.message}`);
        }
      }
    }
  }
  return { activated, errors };
}

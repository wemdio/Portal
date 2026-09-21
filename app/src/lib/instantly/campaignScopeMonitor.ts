import 'server-only';

import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { listAllCustomTagMappings, listAllCustomTags } from './client';
import {
  sendCampaignScopeTelegramAlert,
} from './leadTelegramAlerts';
import type { InstantlyCampaignItem } from '@/lib/tools/autoReportBuilder';
import { detectReservedCampaignScopeIssues } from './campaignScopeRules';

const ALERT_MENTION = 'Jacob_Brown';

type ExistingAlertRow = {
  campaign_id: string;
  last_alerted_at: string | null;
  resolved_at: string | null;
};

/**
 * Hourly, read-only provider audit plus a deduplicated warning. This never
 * changes campaign state or provider tags.
 */
export async function auditReservedCampaignTags(input: {
  accountId: string;
  accountLabel: string;
  campaigns: InstantlyCampaignItem[];
}): Promise<{ issues: number; alerted: number }> {
  if (!supabaseInstantly) throw new Error('Instantly DB is not configured');

  const [tags, mappings] = await Promise.all([
    listAllCustomTags({ accountId: input.accountId, consumer: 'campaign_scope_audit' }),
    listAllCustomTagMappings('campaign', {
      accountId: input.accountId,
      consumer: 'campaign_scope_audit',
    }),
  ]);
  const issues = detectReservedCampaignScopeIssues(input.campaigns, tags, mappings);

  const { data: existingData, error: existingError } = await supabaseInstantly
    .from('instantly_campaign_scope_alerts')
    .select('campaign_id,last_alerted_at,resolved_at')
    .eq('instantly_account_id', input.accountId);
  if (existingError) throw new Error(existingError.message);
  const existing = new Map(
    ((existingData ?? []) as ExistingAlertRow[]).map((row) => [row.campaign_id, row]),
  );

  const now = new Date().toISOString();
  if (issues.length > 0) {
    const { error } = await supabaseInstantly.from('instantly_campaign_scope_alerts').upsert(
      issues.map((issue) => ({
        instantly_account_id: input.accountId,
        campaign_id: issue.campaignId,
        campaign_name: issue.campaignName,
        campaign_status: issue.campaignStatus,
        reserve_tag_ids: issue.reserveTagIds,
        reserve_tag_names: issue.reserveTagNames,
        last_detected_at: now,
        resolved_at: null,
      })),
      { onConflict: 'instantly_account_id,campaign_id' },
    );
    if (error) throw new Error(error.message);
  }

  const currentIds = new Set(issues.map((issue) => issue.campaignId));
  const resolvedIds = [...existing.keys()].filter((campaignId) => !currentIds.has(campaignId));
  if (resolvedIds.length > 0) {
    const { error } = await supabaseInstantly
      .from('instantly_campaign_scope_alerts')
      .update({ resolved_at: now })
      .eq('instantly_account_id', input.accountId)
      .in('campaign_id', resolvedIds)
      .is('resolved_at', null);
    if (error) throw new Error(error.message);
  }

  const newIssues = issues.filter((issue) => {
    const row = existing.get(issue.campaignId);
    return !row || row.resolved_at !== null || row.last_alerted_at === null;
  });
  if (newIssues.length === 0) return { issues: issues.length, alerted: 0 };

  const sent = await sendCampaignScopeTelegramAlert({
    mentionUsername: ALERT_MENTION,
    accountLabel: input.accountLabel,
    campaigns: newIssues,
  });
  const candidateIds = newIssues.map((issue) => issue.campaignId);
  const patch = sent.sent
    ? { last_alerted_at: now, last_alert_error: null }
    : { last_alert_error: sent.error ?? 'Telegram did not confirm delivery' };
  const { error: alertStateError } = await supabaseInstantly
    .from('instantly_campaign_scope_alerts')
    .update(patch)
    .eq('instantly_account_id', input.accountId)
    .in('campaign_id', candidateIds);
  if (alertStateError) throw new Error(alertStateError.message);

  return { issues: issues.length, alerted: sent.sent ? newIssues.length : 0 };
}

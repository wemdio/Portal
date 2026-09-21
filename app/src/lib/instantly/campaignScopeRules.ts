import type { InstantlyCampaignItem } from '@/lib/tools/autoReportBuilder';
import { isReservedMailboxPoolTag } from './mailboxTags';
import {
  CampaignStatus,
  CampaignStatusLabels,
  type CustomTag,
} from './types';
import type { CampaignScopeAlertItem } from './leadTelegramAlerts';

type TagMapping = {
  id?: string;
  tag_id: string;
  resource_id: string;
  resource_type: string;
};

export interface CampaignScopeIssue extends CampaignScopeAlertItem {
  campaignStatus: number | null;
  reserveTagIds: string[];
}

/** Completed campaigns are history and do not need an operational alert. */
export function detectReservedCampaignScopeIssues(
  campaigns: InstantlyCampaignItem[],
  tags: CustomTag[],
  mappings: TagMapping[],
): CampaignScopeIssue[] {
  const reserveTags = new Map(
    tags
      .filter((tag) => isReservedMailboxPoolTag(tag.name))
      .map((tag) => [tag.id, tag.name] as const),
  );
  if (reserveTags.size === 0) return [];

  const tagsByCampaign = new Map<string, Set<string>>();
  for (const mapping of mappings) {
    if (mapping.resource_type !== 'campaign' || !reserveTags.has(mapping.tag_id)) continue;
    const current = tagsByCampaign.get(mapping.resource_id) ?? new Set<string>();
    current.add(mapping.tag_id);
    tagsByCampaign.set(mapping.resource_id, current);
  }

  return campaigns
    .filter((campaign) => campaign.status !== CampaignStatus.Completed)
    .flatMap((campaign): CampaignScopeIssue[] => {
      const tagIds = [...(tagsByCampaign.get(campaign.id) ?? [])].sort();
      if (tagIds.length === 0) return [];
      const status = typeof campaign.status === 'number' ? campaign.status : null;
      return [{
        campaignId: campaign.id,
        campaignName: campaign.name ?? '',
        campaignStatus: status,
        statusLabel: status === null ? 'Статус неизвестен' : (CampaignStatusLabels[status] ?? `Статус ${status}`),
        reserveTagIds: tagIds,
        reserveTagNames: tagIds.map((id) => reserveTags.get(id) ?? id),
      }];
    })
    .sort((a, b) => a.campaignName.localeCompare(b.campaignName, 'ru'));
}

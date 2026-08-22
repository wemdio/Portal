/**
 * Normalized shape returned by Instantly's account-campaign-mappings endpoint.
 * The provider has returned this endpoint both as a bare array and wrapped in
 * `items` / `mappings`, so all consumers must go through this parser.
 */
export interface AccountCampaignMappingItem {
  campaign_id?: string;
  id?: string;
  status?: number;
  timestamp_created?: string;
}

export function parseAccountCampaignMappingItems(raw: unknown): AccountCampaignMappingItem[] {
  if (Array.isArray(raw)) return raw as AccountCampaignMappingItem[];
  if (raw && typeof raw === 'object') {
    const obj = raw as { items?: unknown; mappings?: unknown };
    if (Array.isArray(obj.items)) return obj.items as AccountCampaignMappingItem[];
    if (Array.isArray(obj.mappings)) return obj.mappings as AccountCampaignMappingItem[];
  }
  return [];
}

export function mappingCampaignId(item: AccountCampaignMappingItem): string | null {
  const id = (item.campaign_id ?? item.id ?? '').trim();
  return id || null;
}

export type ClientResourceType = 'campaign' | 'lead_list';

export interface ClientAccessRow {
  resource_type: ClientResourceType;
  resource_id: string;
  instantly_account_id?: string | null;
}

/**
 * Intersect requested IDs with the client's allowed set.
 * When `requestedIds` is empty, returns all allowed IDs of that type
 * (i.e. "give me everything I'm allowed to see").
 */
export function filterAllowedIds(
  requestedIds: string[],
  accessRows: ClientAccessRow[],
  type: ClientResourceType,
): string[] {
  const allowed = new Set(
    accessRows.filter((r) => r.resource_type === type).map((r) => r.resource_id),
  );
  if (requestedIds.length === 0) return [...allowed];
  return requestedIds.filter((id) => allowed.has(id));
}

export function isResourceAllowed(
  resourceId: string,
  accessRows: ClientAccessRow[],
  type: ClientResourceType,
): boolean {
  return accessRows.some(
    (r) => r.resource_type === type && r.resource_id === resourceId,
  );
}

export function getResourceInstantlyAccountId(
  resourceId: string,
  accessRows: ClientAccessRow[],
  type: ClientResourceType,
): string {
  const row = accessRows.find(
    (r) => r.resource_type === type && r.resource_id === resourceId,
  );
  return row?.instantly_account_id || 'main';
}

/**
 * Scope campaign IDs for auto-report: intersect with allowed campaigns.
 * If none requested, returns all allowed campaign IDs.
 */
export function scopeAutoReportCampaignIds(
  requestedCampaignIds: string[],
  accessRows: ClientAccessRow[],
): string[] {
  return filterAllowedIds(requestedCampaignIds, accessRows, 'campaign');
}

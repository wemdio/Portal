import type { SupabaseClient } from '@supabase/supabase-js';

export type CampaignProjectOwnerResolution =
  | { status: 'resolved'; projectId: string }
  | { status: 'none' }
  | { status: 'ambiguous'; projectIds: string[] };

/**
 * Resolve managed-project owners for a campaign batch across both link models.
 *
 * Both reads are mandatory: a partial result could select a stale/wrong
 * project and leak a reply through alerts, client DMs, handoff or the board.
 * Duplicate links to the same project (legacy + one or more periods) are safe;
 * distinct project ids are deliberately fail-closed.
 */
export async function resolveCampaignProjectOwners(
  db: SupabaseClient,
  campaignIds: string[],
): Promise<Map<string, CampaignProjectOwnerResolution>> {
  const uniqueCampaignIds = [...new Set(campaignIds.filter(Boolean))];
  if (uniqueCampaignIds.length === 0) return new Map();

  const [period, legacy] = await Promise.all([
    db
      .from('project_period_instantly_campaigns')
      .select('campaign_id, project_id')
      .in('campaign_id', uniqueCampaignIds),
    db
      .from('project_instantly_campaigns')
      .select('campaign_id, project_id')
      .in('campaign_id', uniqueCampaignIds),
  ]);
  if (period.error) {
    throw new Error(
      `project_period_instantly_campaigns lookup failed: ${period.error.message}`,
    );
  }
  if (legacy.error) {
    throw new Error(
      `project_instantly_campaigns lookup failed: ${legacy.error.message}`,
    );
  }

  const requestedCampaignIds = new Set(uniqueCampaignIds);
  const projectsByCampaign = new Map<string, Set<string>>(
    uniqueCampaignIds.map((campaignId) => [campaignId, new Set<string>()]),
  );
  for (const link of [...(period.data ?? []), ...(legacy.data ?? [])] as Array<{
    campaign_id?: string | null;
    project_id?: string | null;
  }>) {
    const campaignId = link.campaign_id;
    const projectId = link.project_id;
    if (!campaignId || !projectId || !requestedCampaignIds.has(campaignId)) continue;
    projectsByCampaign.get(campaignId)?.add(projectId);
  }

  const resolutions = new Map<string, CampaignProjectOwnerResolution>();
  for (const campaignId of uniqueCampaignIds) {
    const projectIds = [...(projectsByCampaign.get(campaignId) ?? [])];
    if (projectIds.length === 0) {
      resolutions.set(campaignId, { status: 'none' });
    } else if (projectIds.length > 1) {
      resolutions.set(campaignId, { status: 'ambiguous', projectIds });
    } else {
      resolutions.set(campaignId, { status: 'resolved', projectId: projectIds[0] });
    }
  }
  return resolutions;
}

/** Resolve one campaign through the bounded batch implementation. */
export async function resolveCampaignProjectOwner(
  db: SupabaseClient,
  campaignId: string,
): Promise<CampaignProjectOwnerResolution> {
  const resolutions = await resolveCampaignProjectOwners(db, [campaignId]);
  return resolutions.get(campaignId) ?? { status: 'none' };
}

type RpcError = {
  message: string;
  code?: string;
};

type CampaignOwnershipRpcClient = {
  rpc: (
    fn: string,
    params: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: RpcError | null }>;
};

export type CampaignProjectMatchSource = 'auto' | 'auto-text' | 'auto-ai' | 'manual';

export type CampaignProjectOwnershipClaim = {
  projectId: string;
  campaignId: string;
  matchSource: CampaignProjectMatchSource;
  periodId?: string | null;
  baselineContacts?: number;
  matchConfidence?: number | null;
  matchReason?: string | null;
  /** Exact text matches may replace stale automatic ownership, never manual ownership. */
  replaceAutomatic?: boolean;
};

export type CampaignProjectOwnershipResult = {
  status: 'claimed' | 'unchanged' | 'conflict';
  conflictingProjectIds: string[];
};

export type CampaignProjectOwnershipConflict = {
  campaignId: string;
  conflictingProjectIds: string[];
};

export type PeriodCampaignReservation = {
  periodId: string;
  campaignId: string;
  matchSource: CampaignProjectMatchSource;
  baselineContacts: number;
  matchConfidence?: number | null;
  matchReason?: string | null;
};

function parseClaimResult(data: unknown): CampaignProjectOwnershipResult | null {
  const raw = Array.isArray(data) ? data[0] : data;
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  if (row.status !== 'claimed' && row.status !== 'unchanged' && row.status !== 'conflict') {
    return null;
  }
  return {
    status: row.status,
    conflictingProjectIds: Array.isArray(row.conflicting_project_ids)
      ? row.conflicting_project_ids.map(String)
      : [],
  };
}

/**
 * Atomically claims campaign ownership through the Instantly DB RPC.
 *
 * The database function serializes claims per campaign and owns the cross-table
 * invariant. Keeping every writer behind this helper prevents legacy and
 * period-scoped links from drifting apart again.
 */
export async function claimCampaignProjectOwnership(
  db: CampaignOwnershipRpcClient,
  claim: CampaignProjectOwnershipClaim,
): Promise<CampaignProjectOwnershipResult> {
  const { data, error } = await db.rpc('claim_project_instantly_campaign', {
    p_project_id: claim.projectId,
    p_campaign_id: claim.campaignId,
    p_match_source: claim.matchSource,
    p_period_id: claim.periodId ?? null,
    p_baseline_contacts: claim.baselineContacts ?? 0,
    p_match_confidence: claim.matchConfidence ?? null,
    p_match_reason: claim.matchReason ?? null,
    p_replace_automatic: claim.replaceAutomatic ?? false,
  });

  if (error) {
    throw new Error(`campaign ownership claim failed: ${error.message}`);
  }

  const parsed = parseClaimResult(data);
  if (!parsed) {
    throw new Error('campaign ownership claim returned an invalid result');
  }
  return parsed;
}

/** Read-only batch guard used before a cross-database period mutation. */
export async function checkCampaignProjectOwnershipConflicts(
  db: CampaignOwnershipRpcClient,
  projectId: string,
  campaignIds: string[],
): Promise<CampaignProjectOwnershipConflict[]> {
  const uniqueCampaignIds = [...new Set(campaignIds.filter(Boolean))];
  if (uniqueCampaignIds.length === 0) return [];

  const { data, error } = await db.rpc('check_project_instantly_campaign_ownership', {
    p_project_id: projectId,
    p_campaign_ids: uniqueCampaignIds,
  });
  if (error) {
    throw new Error(`campaign ownership preflight failed: ${error.message}`);
  }

  const raw = Array.isArray(data) ? data[0] : data;
  if (!raw || typeof raw !== 'object') {
    throw new Error('campaign ownership preflight returned an invalid result');
  }
  const conflicts = (raw as Record<string, unknown>).conflicts;
  if (!Array.isArray(conflicts)) {
    throw new Error('campaign ownership preflight returned an invalid conflict list');
  }
  return conflicts.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const row = value as Record<string, unknown>;
    if (typeof row.campaign_id !== 'string') return [];
    return [{
      campaignId: row.campaign_id,
      conflictingProjectIds: Array.isArray(row.conflicting_project_ids)
        ? row.conflicting_project_ids.map(String)
        : [],
    }];
  });
}

/** Atomically reserves every new period link in one Instantly DB transaction. */
export async function reservePeriodCampaignLinks(
  db: CampaignOwnershipRpcClient,
  projectId: string,
  links: PeriodCampaignReservation[],
): Promise<CampaignProjectOwnershipResult> {
  if (links.length === 0) return { status: 'unchanged', conflictingProjectIds: [] };
  const { data, error } = await db.rpc('reserve_project_period_instantly_campaigns', {
    p_project_id: projectId,
    p_links: links.map((link) => ({
      period_id: link.periodId,
      campaign_id: link.campaignId,
      match_source: link.matchSource,
      baseline_contacts: link.baselineContacts,
      match_confidence: link.matchConfidence ?? null,
      match_reason: link.matchReason ?? null,
    })),
  });
  if (error) throw new Error(`campaign period reservation failed: ${error.message}`);
  const parsed = parseClaimResult(data);
  if (!parsed) throw new Error('campaign period reservation returned an invalid result');
  return parsed;
}

/** Best-effort saga compensation for pre-generated period IDs. */
export async function releasePeriodCampaignReservations(
  db: CampaignOwnershipRpcClient,
  projectId: string,
  periodIds: string[],
): Promise<void> {
  const uniquePeriodIds = [...new Set(periodIds.filter(Boolean))];
  if (uniquePeriodIds.length === 0) return;
  const { error } = await db.rpc('release_project_period_campaign_reservations', {
    p_project_id: projectId,
    p_period_ids: uniquePeriodIds,
  });
  if (error) throw new Error(`campaign period reservation cleanup failed: ${error.message}`);
}

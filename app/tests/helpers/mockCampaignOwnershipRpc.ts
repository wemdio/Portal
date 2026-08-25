import type { MockSupabaseClient, Row } from './mockSupabase';

type OwnershipRow = Row & {
  id?: unknown;
  project_id?: unknown;
  period_id?: unknown;
  campaign_id?: unknown;
  match_source?: unknown;
};

export async function mockClaimProjectInstantlyCampaign(
  params: Row,
  db: MockSupabaseClient,
): Promise<{ data: unknown }> {
  const projectId = String(params.p_project_id ?? '');
  const campaignId = String(params.p_campaign_id ?? '');
  const periodId = params.p_period_id == null ? null : String(params.p_period_id);
  const matchSource = String(params.p_match_source ?? 'manual');
  const replaceAutomatic = params.p_replace_automatic === true;

  const ownershipRows = () => ([
    ...db.getRows('project_instantly_campaigns').map((row) => ({
      ...row,
      source_table: 'project_instantly_campaigns',
    })),
    ...db.getRows('project_period_instantly_campaigns').map((row) => ({
      ...row,
      source_table: 'project_period_instantly_campaigns',
    })),
  ] as (OwnershipRow & {
    source_table: string;
  })[]).filter((row) => row.campaign_id === campaignId);

  const conflicting = ownershipRows().filter((row) => row.project_id !== projectId);
  const conflictingProjectIds = [...new Set(conflicting.map((row) => String(row.project_id)))];
  if (conflicting.length > 0) {
    const hasManualOwner = conflicting.some((row) => row.match_source === 'manual');
    if (!replaceAutomatic || matchSource !== 'auto-text' || hasManualOwner) {
      return {
        data: {
          status: 'conflict',
          conflicting_project_ids: conflictingProjectIds,
        },
      };
    }

    for (const row of conflicting) {
      await db.from('campaign_project_ownership_archive').insert({
        original_link_id: row.id,
        source_table: row.source_table,
        project_id: row.project_id,
        period_id: row.period_id ?? null,
        baseline_contacts: row.baseline_contacts ?? null,
        campaign_id: row.campaign_id,
        match_source: row.match_source,
        match_confidence: row.match_confidence ?? null,
        match_reason: row.match_reason ?? null,
        original_created_at: row.created_at ?? null,
        archive_reason: 'replaced_stale_automatic_owner',
        replacement_project_id: projectId,
      });
    }

    await db
      .from('project_instantly_campaigns')
      .delete()
      .eq('campaign_id', campaignId)
      .neq('project_id', projectId)
      .neq('match_source', 'manual');
    await db
      .from('project_period_instantly_campaigns')
      .delete()
      .eq('campaign_id', campaignId)
      .neq('project_id', projectId)
      .neq('match_source', 'manual');
  }

  const targetTable = periodId
    ? 'project_period_instantly_campaigns'
    : 'project_instantly_campaigns';
  const targetRow = db.getRows(targetTable).find((row) =>
    row.project_id === projectId &&
    row.campaign_id === campaignId &&
    (periodId == null || row.period_id === periodId));
  const targetExists = Boolean(targetRow);
  const preserveTargetManual = targetRow?.match_source === 'manual' && matchSource !== 'manual';

  const row = {
    project_id: projectId,
    ...(periodId ? { period_id: periodId } : {}),
    campaign_id: campaignId,
    match_source: preserveTargetManual ? 'manual' : matchSource,
    ...(periodId
      ? {
          baseline_contacts: preserveTargetManual
            ? Number(targetRow?.baseline_contacts ?? 0)
            : Number(params.p_baseline_contacts ?? 0),
        }
      : {}),
    ...(preserveTargetManual
      ? { match_confidence: targetRow?.match_confidence ?? null }
      : params.p_match_confidence == null
      ? {}
      : { match_confidence: params.p_match_confidence }),
    ...(preserveTargetManual
      ? { match_reason: targetRow?.match_reason ?? null }
      : params.p_match_reason == null
        ? {}
        : { match_reason: params.p_match_reason }),
  };
  await db
    .from(targetTable)
    .upsert(row, {
      onConflict: periodId ? 'period_id,campaign_id' : 'project_id,campaign_id',
    });

  return {
    data: {
      status: conflicting.length > 0 || !targetExists ? 'claimed' : 'unchanged',
      conflicting_project_ids: [],
    },
  };
}

export async function mockCheckProjectInstantlyCampaignOwnership(
  params: Row,
  db: MockSupabaseClient,
): Promise<{ data: unknown }> {
  const projectId = String(params.p_project_id ?? '');
  const campaignIds = Array.isArray(params.p_campaign_ids)
    ? params.p_campaign_ids.map(String)
    : [];
  const conflictsByCampaign = new Map<string, Set<string>>();
  for (const row of [
    ...db.getRows('project_instantly_campaigns'),
    ...db.getRows('project_period_instantly_campaigns'),
  ] as OwnershipRow[]) {
    const campaignId = String(row.campaign_id ?? '');
    const ownerProjectId = String(row.project_id ?? '');
    if (!campaignIds.includes(campaignId) || ownerProjectId === projectId) continue;
    const owners = conflictsByCampaign.get(campaignId) ?? new Set<string>();
    owners.add(ownerProjectId);
    conflictsByCampaign.set(campaignId, owners);
  }
  return {
    data: {
      conflicts: [...conflictsByCampaign].map(([campaignId, ownerProjectIds]) => ({
        campaign_id: campaignId,
        conflicting_project_ids: [...ownerProjectIds],
      })),
    },
  };
}

export async function mockReserveProjectPeriodInstantlyCampaigns(
  params: Row,
  db: MockSupabaseClient,
): Promise<{ data: unknown; error?: { message: string } }> {
  const projectId = String(params.p_project_id ?? '');
  const links = Array.isArray(params.p_links) ? params.p_links as Row[] : [];
  const allowedSources = new Set(['auto', 'auto-text', 'auto-ai', 'manual']);
  if (links.some((link) =>
    !link.period_id ||
    !link.campaign_id ||
    !allowedSources.has(String(link.match_source)))) {
    return { data: null, error: { message: 'invalid period reservation link' } };
  }

  const preflight = await mockCheckProjectInstantlyCampaignOwnership({
    p_project_id: projectId,
    p_campaign_ids: links.map((link) => String(link.campaign_id)),
  }, db);
  const conflicts = (preflight.data as { conflicts: unknown[] }).conflicts;
  if (conflicts.length > 0) {
    const first = conflicts[0] as { conflicting_project_ids?: string[] };
    return {
      data: {
        status: 'conflict',
        conflicting_project_ids: first.conflicting_project_ids ?? [],
      },
    };
  }

  for (const link of links) {
    await db.from('project_period_instantly_campaigns').upsert({
      project_id: projectId,
      period_id: String(link.period_id),
      campaign_id: String(link.campaign_id),
      match_source: String(link.match_source),
      baseline_contacts: Number(link.baseline_contacts ?? 0),
      match_confidence: link.match_confidence ?? null,
      match_reason: link.match_reason ?? null,
    }, { onConflict: 'period_id,campaign_id' });
  }
  return {
    data: {
      status: links.length > 0 ? 'claimed' : 'unchanged',
      conflicting_project_ids: [],
    },
  };
}

export async function mockReleaseProjectPeriodCampaignReservations(
  params: Row,
  db: MockSupabaseClient,
): Promise<{ data: unknown }> {
  const projectId = String(params.p_project_id ?? '');
  const periodIds = Array.isArray(params.p_period_ids)
    ? params.p_period_ids.map(String)
    : [];
  await db
    .from('project_period_instantly_campaigns')
    .delete()
    .eq('project_id', projectId)
    .in('period_id', periodIds);
  return { data: { released: true } };
}

export const campaignOwnershipRpcHandlers = {
  claim_project_instantly_campaign: mockClaimProjectInstantlyCampaign,
  check_project_instantly_campaign_ownership: mockCheckProjectInstantlyCampaignOwnership,
  reserve_project_period_instantly_campaigns: mockReserveProjectPeriodInstantlyCampaigns,
  release_project_period_campaign_reservations: mockReleaseProjectPeriodCampaignReservations,
};

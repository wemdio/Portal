import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { supabaseAdmin as supabaseMain } from '@/lib/supabaseAdmin';
import { resolveCampaignProjectOwners } from '@/lib/instantly/campaignProjectOwnerResolver';

export const dynamic = 'force-dynamic';

const SUPERVISOR_ROLES = new Set(['admin', 'director', 'lead', 'manager']);

interface CampaignAccess {
  campaignIds: string[];
  rejectedExplicitCampaign: boolean;
  ambiguousCampaignIds: string[];
}

/**
 * Resolve campaigns visible to the caller through one unambiguous project
 * owner. Link reads are deliberately mandatory: using only one of the legacy
 * or period tables could expose a historically duplicated campaign to two
 * specialists.
 */
async function resolveCampaignAccess(
  userId: string,
  requestedCampaignIds: string[],
): Promise<CampaignAccess> {
  const instantlyDb = supabaseInstantly;
  const mainDb = supabaseMain;
  if (!instantlyDb || !mainDb) {
    throw new Error('Server misconfigured');
  }

  const { data: profile, error: profileError } = await mainDb
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .single();
  if (profileError || !profile) {
    throw new Error(`Unable to resolve user role: ${profileError?.message ?? 'profile not found'}`);
  }

  let projectsQuery = mainDb.from('projects').select('id');
  if (!SUPERVISOR_ROLES.has((profile.role as string | null) ?? 'technician')) {
    projectsQuery = projectsQuery.eq('specialist_user_id', userId);
  }
  const { data: projects, error: projectsError } = await projectsQuery;
  if (projectsError) {
    throw new Error(`Unable to resolve visible projects: ${projectsError.message}`);
  }

  const visibleProjectIds = new Set(
    (projects ?? [])
      .map((project: { id?: string | null }) => project.id)
      .filter((projectId): projectId is string => Boolean(projectId)),
  );

  const explicitCampaignIds = [...new Set(requestedCampaignIds.filter(Boolean))];
  let candidateCampaignIds = explicitCampaignIds;
  if (candidateCampaignIds.length === 0 && visibleProjectIds.size > 0) {
    const projectIds = [...visibleProjectIds];
    const [legacy, period] = await Promise.all([
      instantlyDb
        .from('project_instantly_campaigns')
        .select('campaign_id')
        .in('project_id', projectIds),
      instantlyDb
        .from('project_period_instantly_campaigns')
        .select('campaign_id')
        .in('project_id', projectIds),
    ]);
    if (legacy.error) {
      throw new Error(`project_instantly_campaigns lookup failed: ${legacy.error.message}`);
    }
    if (period.error) {
      throw new Error(`project_period_instantly_campaigns lookup failed: ${period.error.message}`);
    }
    candidateCampaignIds = [...new Set(
      [...(legacy.data ?? []), ...(period.data ?? [])]
        .map((link: { campaign_id?: string | null }) => link.campaign_id)
        .filter((campaignId): campaignId is string => Boolean(campaignId)),
    )];
  }

  const owners = await resolveCampaignProjectOwners(instantlyDb, candidateCampaignIds);
  const ambiguousCampaignIds = candidateCampaignIds.filter(
    (campaignId) => owners.get(campaignId)?.status === 'ambiguous',
  );
  const campaignIds = candidateCampaignIds.filter((campaignId) => {
    const owner = owners.get(campaignId);
    return owner?.status === 'resolved' && visibleProjectIds.has(owner.projectId);
  });

  return {
    campaignIds,
    rejectedExplicitCampaign:
      explicitCampaignIds.length > 0 && campaignIds.length !== explicitCampaignIds.length,
    ambiguousCampaignIds,
  };
}

export const PATCH = withAuth(async (req, user) => {
  const instantlyDb = supabaseInstantly;
  if (!instantlyDb || !supabaseMain) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const body = await req.json() as { ids?: string[] };
  const rawIds = body.ids;
  if (
    !rawIds ||
    !Array.isArray(rawIds) ||
    rawIds.length === 0 ||
    rawIds.some((id) => typeof id !== 'string' || id.length === 0)
  ) {
    return NextResponse.json({ error: 'ids required' }, { status: 400 });
  }
  const ids = [...new Set(rawIds)];

  const { data: qualifications, error: qualificationsError } = await instantlyDb
    .from('instantly_lead_qualifications')
    .select('id, campaign_id')
    .in('id', ids);
  if (qualificationsError) {
    return NextResponse.json({ error: qualificationsError.message }, { status: 500 });
  }

  const qualificationsById = new Map(
    (qualifications ?? []).map((qualification) => [
      qualification.id as string,
      (qualification.campaign_id as string | null) ?? '',
    ]),
  );
  if (ids.some((id) => !qualificationsById.has(id))) {
    return NextResponse.json({ error: 'Квалификация не найдена' }, { status: 404 });
  }
  const campaignIds = [...new Set(ids.map((id) => qualificationsById.get(id) ?? ''))];
  if (campaignIds.some((campaignId) => !campaignId)) {
    return NextResponse.json({ error: 'У квалификации не указана кампания' }, { status: 409 });
  }

  const access = await resolveCampaignAccess(user.id, campaignIds);
  if (access.ambiguousCampaignIds.length > 0) {
    return NextResponse.json(
      { error: 'Не удалось однозначно определить проект кампании' },
      { status: 409 },
    );
  }
  if (access.rejectedExplicitCampaign) {
    return NextResponse.json({ error: 'Доступ к кампании запрещён' }, { status: 403 });
  }

  const { error } = await instantlyDb
    .from('instantly_lead_qualifications')
    .update({ read_at: new Date().toISOString(), read_by: user.id })
    .in('id', ids)
    // Keep the authorization decision attached to the write if a row changes
    // between the qualification read and this best-effort cross-DB update.
    .in('campaign_id', access.campaignIds)
    .is('read_at', null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
});

export const GET = withAuth(async (req, user) => {
  if (!supabaseInstantly || !supabaseMain) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const url = new URL(req.url);
  const status = url.searchParams.get('status');
  const campaignId = url.searchParams.get('campaign_id');
  const campaignIds = url.searchParams.getAll('campaign_ids');
  const search = url.searchParams.get('search');
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 200);
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
  const requestedCampaignIds = campaignId ? [campaignId] : campaignIds;
  const access = await resolveCampaignAccess(user.id, requestedCampaignIds);
  if (access.rejectedExplicitCampaign) {
    return NextResponse.json({ error: 'Доступ к кампании запрещён' }, { status: 403 });
  }

  if (access.campaignIds.length === 0) {
    return NextResponse.json({
      items: [],
      total: 0,
      limit,
      offset,
      counts: { lead: 0, objection: 0, needs_review: 0, not_lead: 0, error: 0 },
    });
  }

  let query = supabaseInstantly
    .from('instantly_lead_qualifications')
    .select('*', { count: 'exact' });

  if (status && status !== 'all') {
    query = query.eq('status', status);
  } else {
    query = query.neq('status', 'pending');
  }

  query = query.in('campaign_id', access.campaignIds);

  if (search) {
    query = query.or(
      `lead_email.ilike.%${search}%,lead_name.ilike.%${search}%,company_name.ilike.%${search}%`,
    );
  }

  const { data, count, error } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Build status counts with the same campaign/preference/search filters
  const statuses = ['lead', 'objection', 'needs_review', 'not_lead', 'error'] as const;
  const counts: Record<string, number> = {};

  await Promise.all(
    statuses.map(async (s) => {
      let cq = supabaseInstantly!
        .from('instantly_lead_qualifications')
        .select('*', { count: 'exact', head: true })
        .eq('status', s);

      cq = cq.in('campaign_id', access.campaignIds);

      if (search) {
        cq = cq.or(
          `lead_email.ilike.%${search}%,lead_name.ilike.%${search}%,company_name.ilike.%${search}%`,
        );
      }

      const { count: c, error: countError } = await cq;
      if (countError) throw new Error(countError.message);
      counts[s] = c ?? 0;
    }),
  );

  return NextResponse.json({
    items: data ?? [],
    total: count ?? 0,
    limit,
    offset,
    counts,
  });
});

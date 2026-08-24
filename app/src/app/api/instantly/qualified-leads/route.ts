import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { supabaseAdmin as supabaseMain } from '@/lib/supabaseAdmin';
import {
  authorizeQualificationRowsForUser,
  qualificationProjectSnapshotSupported,
  qualifiedLeadAccessErrorResponse,
  resolveQualificationReadScope,
} from '@/lib/instantly/qualifiedLeadAuthorization';

export const dynamic = 'force-dynamic';

const MAX_PAGE_SIZE = 200;
const MAX_OFFSET = 10_000;
const SOURCE_PAGE_SIZE = 1_000;

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

  // `select('*')` may hide newly added fields behind a stale PostgREST schema
  // cache. Probe explicitly so a proven snapshot can never be reinterpreted as
  // a live-owner legacy row during rollout.
  await qualificationProjectSnapshotSupported();

  const { data: qualifications, error: qualificationsError } = await instantlyDb
    .from('instantly_lead_qualifications')
    // `*` keeps code-before-migration compatible: selecting the new snapshot
    // column by name would fail until the Instantly migration is visible.
    .select('*')
    .in('id', ids);
  if (qualificationsError) {
    return NextResponse.json({ error: qualificationsError.message }, { status: 500 });
  }

  const qualificationRows = (qualifications ?? []) as Array<Record<string, unknown>>;
  const qualificationsById = new Map(
    qualificationRows.map((qualification) => [qualification.id as string, qualification]),
  );
  if (ids.some((id) => !qualificationsById.has(id))) {
    return NextResponse.json({ error: 'Квалификация не найдена' }, { status: 404 });
  }
  const orderedQualifications = ids.map((id) => qualificationsById.get(id)!);
  const authorization = await authorizeQualificationRowsForUser(user.id, orderedQualifications);
  if (!authorization.ok) return qualifiedLeadAccessErrorResponse(authorization);

  type OwnerState = 'missing' | 'proven' | 'unresolved' | 'legacy';
  interface MarkReadGroup {
    ids: string[];
    campaignId: string;
    projectId: string | null;
    ownerState: OwnerState;
  }
  const groups = new Map<string, MarkReadGroup>();
  const updatedIds = new Set<string>();
  for (const qualification of orderedQualifications) {
    const qualificationId = qualification.id as string;
    if (qualification.read_at !== null && qualification.read_at !== undefined) {
      updatedIds.add(qualificationId);
      continue;
    }
    const campaignId = qualification.campaign_id as string;
    const projectId = typeof qualification.qualified_project_id === 'string'
      ? qualification.qualified_project_id.trim() || null
      : null;
    const ownerFieldPresent = Object.prototype.hasOwnProperty.call(
      qualification,
      'qualified_project_owner_proven',
    );
    const ownerState: OwnerState = !ownerFieldPresent
      ? 'missing'
      : qualification.qualified_project_owner_proven === true
        ? 'proven'
        : qualification.qualified_project_owner_proven === false
          ? 'unresolved'
          : 'legacy';
    const key = JSON.stringify([campaignId, projectId, ownerState]);
    const group = groups.get(key) ?? {
      ids: [],
      campaignId,
      projectId,
      ownerState,
    };
    group.ids.push(qualificationId);
    groups.set(key, group);
  }

  const readAt = new Date().toISOString();
  for (const group of groups.values()) {
    let update = instantlyDb
      .from('instantly_lead_qualifications')
      .update({ read_at: readAt, read_by: user.id })
      .in('id', group.ids)
      .eq('campaign_id', group.campaignId)
      .is('read_at', null);
    if (group.ownerState !== 'missing') {
      update = group.ownerState === 'legacy'
        ? update.is('qualified_project_owner_proven', null)
        : update.eq(
            'qualified_project_owner_proven',
            group.ownerState === 'proven',
          );
      update = group.projectId
        ? update.eq('qualified_project_id', group.projectId)
        : update.is('qualified_project_id', null);
    }
    const { data: updated, error } = await update.select('id');
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    for (const row of updated ?? []) updatedIds.add(row.id as string);
  }

  if (ids.some((id) => !updatedIds.has(id))) {
    return NextResponse.json(
      { error: 'Квалификация изменилась после проверки доступа; обновите список' },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true });
});

export const GET = withAuth(async (req, user) => {
  if (!supabaseInstantly || !supabaseMain) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }
  const instantlyDb = supabaseInstantly;

  const url = new URL(req.url);
  const status = url.searchParams.get('status');
  const campaignId = url.searchParams.get('campaign_id');
  const campaignIds = url.searchParams.getAll('campaign_ids');
  const search = url.searchParams.get('search');
  const rawLimit = Number(url.searchParams.get('limit') ?? '50');
  const rawOffset = Number(url.searchParams.get('offset') ?? '0');
  if (
    !Number.isInteger(rawLimit) ||
    rawLimit < 1 ||
    !Number.isInteger(rawOffset) ||
    rawOffset < 0 ||
    rawOffset > MAX_OFFSET
  ) {
    return NextResponse.json(
      {
        error:
          `limit должен быть целым числом >= 1, offset — целым числом от 0 до ${MAX_OFFSET}`,
      },
      { status: 400 },
    );
  }
  const limit = Math.min(rawLimit, MAX_PAGE_SIZE);
  const offset = rawOffset;
  const requestedCampaignIds = campaignId ? [campaignId] : campaignIds;
  const { visibleProjectIds, campaignAccess } = await resolveQualificationReadScope(
    user.id,
    requestedCampaignIds,
  );
  const snapshotSupported = await qualificationProjectSnapshotSupported();
  const emptyResponse = () => NextResponse.json({
    items: [],
    total: 0,
    limit,
    offset,
    counts: { lead: 0, objection: 0, needs_review: 0, not_lead: 0, error: 0 },
  });

  // Code-before-migration compatibility. The new worker defers every new
  // qualification until the snapshot columns are available, so rows in this
  // branch are necessarily legacy and follow live campaign ownership.
  if (!snapshotSupported) {
    if (campaignAccess.rejectedExplicitCampaign) {
      return NextResponse.json({ error: 'Доступ к кампании запрещён' }, { status: 403 });
    }
    if (campaignAccess.campaignIds.length === 0) return emptyResponse();

    let query = instantlyDb
      .from('instantly_lead_qualifications')
      .select('*', { count: 'exact' });
    query = status && status !== 'all'
      ? query.eq('status', status)
      : query.neq('status', 'pending');
    query = query.in('campaign_id', campaignAccess.campaignIds);
    if (search) {
      query = query.or(
        `lead_email.ilike.%${search}%,lead_name.ilike.%${search}%,company_name.ilike.%${search}%`,
      );
    }
    const { data, count, error } = await query
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(offset, offset + limit - 1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const statuses = ['lead', 'objection', 'needs_review', 'not_lead', 'error'] as const;
    const counts: Record<string, number> = {};
    await Promise.all(statuses.map(async (value) => {
      let countQuery = instantlyDb
        .from('instantly_lead_qualifications')
        .select('*', { count: 'exact', head: true })
        .eq('status', value)
        .in('campaign_id', campaignAccess.campaignIds);
      if (search) {
        countQuery = countQuery.or(
          `lead_email.ilike.%${search}%,lead_name.ilike.%${search}%,company_name.ilike.%${search}%`,
        );
      }
      const { count: scopedCount, error: countError } = await countQuery;
      if (countError) throw new Error(countError.message);
      counts[value] = scopedCount ?? 0;
    }));
    return NextResponse.json({ items: data ?? [], total: count ?? 0, limit, offset, counts });
  }

  // An explicit campaign is accessible when it is currently owned by a
  // visible project OR contains historical qualifications snapshotted to one.
  // This keeps old leads with project A after the campaign itself moves to B.
  if (requestedCampaignIds.length > 0) {
    let snapshottedCampaignIds = new Set<string>();
    if (visibleProjectIds.length > 0) {
      const { data: snapshotCampaigns, error: snapshotCampaignError } = await instantlyDb
        .from('instantly_lead_qualifications')
        .select('campaign_id')
        .in('campaign_id', requestedCampaignIds)
        .eq('qualified_project_owner_proven', true)
        .in('qualified_project_id', visibleProjectIds);
      if (snapshotCampaignError) {
        return NextResponse.json({ error: snapshotCampaignError.message }, { status: 500 });
      }
      snapshottedCampaignIds = new Set(
        (snapshotCampaigns ?? [])
          .map((row) => row.campaign_id as string | null)
          .filter((id): id is string => Boolean(id)),
      );
    }
    const allowedCampaignIds = new Set([
      ...campaignAccess.campaignIds,
      ...snapshottedCampaignIds,
    ]);
    const rejectedCampaignIds = requestedCampaignIds.filter(
      (requested) => !allowedCampaignIds.has(requested),
    );
    if (rejectedCampaignIds.length > 0) {
      const ambiguous = rejectedCampaignIds.some((rejected) =>
        campaignAccess.ambiguousCampaignIds.includes(rejected),
      );
      return NextResponse.json(
        {
          error: ambiguous
            ? 'Не удалось однозначно определить проект кампании'
            : 'Доступ к кампании запрещён',
        },
        { status: ambiguous ? 409 : 403 },
      );
    }
  }

  if (visibleProjectIds.length === 0 && campaignAccess.campaignIds.length === 0) {
    return emptyResponse();
  }

  type QualificationSource =
    | { kind: 'snapshot'; projectIds: string[] }
    | { kind: 'legacy'; campaignIds: string[] };

  const snapshotSource: QualificationSource | null = visibleProjectIds.length > 0
    ? { kind: 'snapshot', projectIds: visibleProjectIds }
    : null;
  const legacySource: QualificationSource | null = campaignAccess.campaignIds.length > 0
    ? { kind: 'legacy', campaignIds: campaignAccess.campaignIds }
    : null;

  const buildSourceQuery = (
    source: QualificationSource,
    statusFilter: string | null,
    head = false,
  ) => {
    let query = instantlyDb
      .from('instantly_lead_qualifications')
      .select('*', { count: 'exact', head });
    if (source.kind === 'snapshot') {
      query = query
        .eq('qualified_project_owner_proven', true)
        .in('qualified_project_id', source.projectIds);
      if (requestedCampaignIds.length > 0) {
        query = query.in('campaign_id', requestedCampaignIds);
      }
    } else {
      // FALSE is a durable retry/unresolved row; NULL is pre-migration history.
      // Both remain tied to the live owner until the worker proves a snapshot.
      query = query
        .or(
          'qualified_project_owner_proven.eq.false,' +
          'qualified_project_owner_proven.is.null',
        )
        .is('qualified_project_id', null)
        .in('campaign_id', source.campaignIds);
    }
    query = statusFilter
      ? query.eq('status', statusFilter)
      : query.neq('status', 'pending');
    if (search) {
      query = query.or(
        `lead_email.ilike.%${search}%,lead_name.ilike.%${search}%,company_name.ilike.%${search}%`,
      );
    }
    return query;
  };

  const pageEnd = offset + limit - 1;
  const fetchSourcePrefix = async (source: QualificationSource | null) => {
    if (!source) return { data: [] as Array<Record<string, unknown>>, count: 0, error: null };

    const data: Array<Record<string, unknown>> = [];
    let exactCount: number | null = null;
    for (let start = 0; start <= pageEnd; start += SOURCE_PAGE_SIZE) {
      const end = Math.min(pageEnd, start + SOURCE_PAGE_SIZE - 1);
      const page = await buildSourceQuery(
        source,
        status && status !== 'all' ? status : null,
      )
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(start, end);
      if (page.error) {
        return { data: [], count: 0, error: page.error };
      }

      const rows = (page.data ?? []) as Array<Record<string, unknown>>;
      data.push(...rows);
      if (exactCount === null && typeof page.count === 'number') exactCount = page.count;
      const requestedRows = end - start + 1;
      if (
        rows.length < requestedRows ||
        (exactCount !== null && data.length >= exactCount)
      ) {
        break;
      }
    }
    return { data, count: exactCount ?? data.length, error: null };
  };

  const snapshotPagePromise = fetchSourcePrefix(snapshotSource);
  const legacyPagePromise = fetchSourcePrefix(legacySource);

  const [snapshotPage, legacyPage] = await Promise.all([
    snapshotPagePromise,
    legacyPagePromise,
  ]);
  if (snapshotPage.error || legacyPage.error) {
    return NextResponse.json(
      { error: snapshotPage.error?.message ?? legacyPage.error?.message },
      { status: 500 },
    );
  }
  const mergedRows = [
    ...((snapshotPage.data ?? []) as Array<Record<string, unknown>>),
    ...((legacyPage.data ?? []) as Array<Record<string, unknown>>),
  ].sort((left, right) => {
    const leftAt = Date.parse((left.created_at as string | null) ?? '') || 0;
    const rightAt = Date.parse((right.created_at as string | null) ?? '') || 0;
    return rightAt - leftAt || String(left.id ?? '').localeCompare(String(right.id ?? ''));
  });
  const items = mergedRows.slice(offset, offset + limit);
  const total = (snapshotPage.count ?? 0) + (legacyPage.count ?? 0);

  const statuses = ['lead', 'objection', 'needs_review', 'not_lead', 'error'] as const;
  const countEntries = await Promise.all(statuses.map(async (value) => {
    const countSource = async (source: QualificationSource | null) => {
      if (!source) return { count: 0, error: null };
      const result = await buildSourceQuery(source, value, true);
      return { count: result.count ?? 0, error: result.error };
    };
    const snapshotCountPromise = countSource(snapshotSource);
    const legacyCountPromise = countSource(legacySource);
    const [snapshotCount, legacyCount] = await Promise.all([
      snapshotCountPromise,
      legacyCountPromise,
    ]);
    if (snapshotCount.error || legacyCount.error) {
      throw new Error(snapshotCount.error?.message ?? legacyCount.error?.message);
    }
    return [value, (snapshotCount.count ?? 0) + (legacyCount.count ?? 0)] as const;
  }));
  const counts = Object.fromEntries(countEntries);

  return NextResponse.json({ items, total, limit, offset, counts });
});

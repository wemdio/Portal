import { NextRequest, NextResponse } from 'next/server';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { claimCampaignProjectOwnership } from '@/lib/instantly/campaignProjectOwnership';

export const dynamic = 'force-dynamic';

type ActivePeriod = {
  id: string;
  period_start: string | null;
  created_at: string | null;
};

type ReadResult<T> = {
  data: T;
  error: string | null;
};

async function getActivePeriod(projectId: string): Promise<ReadResult<ActivePeriod | null>> {
  if (!supabaseAdmin) return { data: null, error: 'Server misconfigured' };
  const { data, error } = await supabaseAdmin
    .from('project_periods')
    .select('id, period_start, created_at')
    .eq('project_id', projectId)
    .eq('status', 'active')
    .maybeSingle();
  if (error) return { data: null, error: error.message };
  return { data: (data as ActivePeriod | null) ?? null, error: null };
}

/**
 * Граница периода для baseline = момент ОТКРЫТИЯ периода (`created_at`,
 * нажатие кнопки «Новый период»), а не введённая `period_start`/дедлайн.
 * Кампания, созданная до открытия периода, считается «старой»: при ручном
 * добавлении ей ставится baseline = текущий счётчик (в новый период попадёт
 * только дельта, без задвоения с прошлым периодом). Кампания, созданная после
 * открытия, — целиком новая (baseline 0). См. campaignStartsInsidePeriod в
 * instantlyCampaignCatalog.ts (автоматчеры используют ту же границу).
 */
function campaignStartsInsidePeriod(
  campaign: { timestamp_created?: string | null },
  period: ActivePeriod,
): boolean {
  if (!period.created_at) return true;
  const campaignMs = Date.parse(campaign.timestamp_created ?? '');
  const boundaryMs = Date.parse(period.created_at);
  if (!Number.isFinite(campaignMs) || !Number.isFinite(boundaryMs)) return false;
  return campaignMs >= boundaryMs;
}

async function getCampaignBaseline(
  campaignId: string,
  activePeriod: ActivePeriod,
): Promise<ReadResult<number>> {
  if (!supabaseInstantly) return { data: 0, error: 'Server misconfigured' };
  const { data, error } = await supabaseInstantly
    .from('instantly_campaign_catalog')
    .select('id, timestamp_created, new_leads_contacted_count')
    .eq('id', campaignId)
    .maybeSingle();
  if (error) return { data: 0, error: error.message };
  if (!data) return { data: 0, error: null };
  if (campaignStartsInsidePeriod(data as { timestamp_created?: string | null }, activePeriod)) {
    return { data: 0, error: null };
  }
  const n = Number((data as { new_leads_contacted_count?: number | null }).new_leads_contacted_count);
  return { data: Number.isFinite(n) ? n : 0, error: null };
}

/**
 * Подписи проектов целиком (162 строки, ~3 КБ меток), а не `.in('id', [...])`:
 * владельцев кампаний больше сотни, и список uuid раздул бы GET-строку к REST
 * до ~5 КБ — впритык к nginx-буферу заголовков ради выборки, которая и так меньше.
 */
async function getProjectLabels(): Promise<Record<string, string>> {
  if (!supabaseAdmin) return {};
  const { data, error } = await supabaseAdmin
    .from('projects')
    .select('id, client, name');
  if (error || !data) return {};
  const rows = data as { id: string; client: string | null; name: string | null }[];
  return Object.fromEntries(
    rows.map((row) => [row.id, row.client?.trim() || row.name?.trim() || row.id]),
  );
}

/**
 * Кампания принадлежит ровно одному проекту (см. claim_project_instantly_campaign).
 * Пикер об этом не знал: клик по чужой кампании ловил 409, фронт его молчал, и
 * выглядело это как «кнопка привязки не работает». Отдаём карту занятых кампаний,
 * чтобы список сразу показывал владельца. Читается лениво (?taken=1), только когда
 * специалист открыл пикер, — обычный GET карточки остаётся лёгким.
 */
async function getCampaignsTakenByOtherProjects(
  projectId: string,
): Promise<Record<string, string>> {
  if (!supabaseInstantly) return {};
  const [legacy, period] = await Promise.all([
    supabaseInstantly
      .from('project_instantly_campaigns')
      .select('campaign_id, project_id')
      .neq('project_id', projectId),
    supabaseInstantly
      .from('project_period_instantly_campaigns')
      .select('campaign_id, project_id')
      .neq('project_id', projectId),
  ]);
  if (legacy.error || period.error) return {};

  const rows = [
    ...(legacy.data ?? []),
    ...(period.data ?? []),
  ] as { campaign_id: string; project_id: string }[];

  const ownerByCampaign = new Map<string, string>();
  for (const row of rows) {
    if (!ownerByCampaign.has(row.campaign_id)) ownerByCampaign.set(row.campaign_id, row.project_id);
  }
  if (ownerByCampaign.size === 0) return {};

  const labels = await getProjectLabels();
  const taken: Record<string, string> = {};
  for (const [campaignId, ownerId] of ownerByCampaign) {
    taken[campaignId] = labels[ownerId] ?? ownerId;
  }
  return taken;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  const wantsTaken = new URL(req.url).searchParams.get('taken') === '1';
  if (!supabaseInstantly) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }
  const activePeriodRead = await getActivePeriod(projectId);
  if (activePeriodRead.error) {
    return NextResponse.json({ error: activePeriodRead.error }, { status: 500 });
  }
  const activePeriod = activePeriodRead.data;

  const query = activePeriod
    ? supabaseInstantly
        .from('project_period_instantly_campaigns')
        .select('campaign_id, match_source, created_at, period_id, baseline_contacts')
        .eq('period_id', activePeriod.id)
    : supabaseInstantly
        .from('project_instantly_campaigns')
        .select('campaign_id, match_source, created_at')
        .eq('project_id', projectId);

  const { data, error } = await query.order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Enrich with campaign names from catalog
  const campaignIds = (data ?? []).map((r) => r.campaign_id as string);
  let nameMap: Record<string, string> = {};

  if (campaignIds.length > 0) {
    const { data: catalog } = await supabaseInstantly
      .from('instantly_campaign_catalog')
      .select('id, name')
      .in('id', campaignIds);

    if (catalog) {
      nameMap = Object.fromEntries(
        catalog.map((c: { id: string; name: string }) => [c.id, c.name]),
      );
    }
  }

  const items = (data ?? []).map((r) => ({
    campaign_id: r.campaign_id as string,
    campaign_name: nameMap[r.campaign_id as string] ?? r.campaign_id,
    match_source: r.match_source as string,
    created_at: r.created_at as string,
    period_id: (r as { period_id?: string | null }).period_id ?? null,
    baseline_contacts: (r as { baseline_contacts?: number | null }).baseline_contacts ?? null,
  }));

  const taken = wantsTaken ? await getCampaignsTakenByOtherProjects(projectId) : undefined;

  return NextResponse.json({ items, activePeriod, ...(taken ? { taken } : {}) });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  if (!supabaseInstantly) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const body = await req.json() as { campaign_id?: string };
  if (!body.campaign_id) {
    return NextResponse.json({ error: 'campaign_id required' }, { status: 400 });
  }

  const activePeriodRead = await getActivePeriod(projectId);
  if (activePeriodRead.error) {
    return NextResponse.json({ error: activePeriodRead.error }, { status: 500 });
  }
  const activePeriod = activePeriodRead.data;
  const baselineRead = activePeriod
    ? await getCampaignBaseline(body.campaign_id, activePeriod)
    : { data: 0, error: null };
  if (baselineRead.error) {
    return NextResponse.json({ error: baselineRead.error }, { status: 500 });
  }
  try {
    const claim = await claimCampaignProjectOwnership(supabaseInstantly, {
      projectId,
      campaignId: body.campaign_id,
      matchSource: 'manual',
      periodId: activePeriod?.id ?? null,
      baselineContacts: baselineRead.data,
      replaceAutomatic: false,
    });
    if (claim.status === 'conflict') {
      const labels = await getProjectLabels();
      const owners = claim.conflictingProjectIds.map((ownerId) => labels[ownerId] ?? ownerId);
      return NextResponse.json(
        {
          error: owners.length > 0
            ? `Кампания уже привязана к проекту «${owners.join(', ')}»`
            : 'Кампания уже привязана к другому проекту',
          conflicting_project_ids: claim.conflictingProjectIds,
        },
        { status: 409 },
      );
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Campaign assignment failed' },
      { status: 500 },
    );
  }

  // Если специалист руками добавил кампанию обратно — это явная отмена
  // прошлого решения «удалить из карточки». Снимаем её с denylist'а, чтобы
  // авто-матчер не воспринимал её как «всегда исключать».
  await supabaseInstantly
    .from('project_instantly_campaigns_denylist')
    .delete()
    .eq('project_id', projectId)
    .eq('campaign_id', body.campaign_id);

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  if (!supabaseInstantly) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const url = new URL(req.url);
  const campaignId = url.searchParams.get('campaign_id');
  if (!campaignId) {
    return NextResponse.json({ error: 'campaign_id required' }, { status: 400 });
  }

  const activePeriodRead = await getActivePeriod(projectId);
  if (activePeriodRead.error) {
    return NextResponse.json({ error: activePeriodRead.error }, { status: 500 });
  }
  const activePeriod = activePeriodRead.data;
  const { error } = activePeriod
    ? await supabaseInstantly
        .from('project_period_instantly_campaigns')
        .delete()
        .eq('period_id', activePeriod.id)
        .eq('campaign_id', campaignId)
    : await supabaseInstantly
        .from('project_instantly_campaigns')
        .delete()
        .eq('project_id', projectId)
        .eq('campaign_id', campaignId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Запоминаем пару, чтобы автопривязка её больше не пихала обратно.
  // Без этого text-match (campaign.name LIKE %client%) и AI-матчер на
  // следующей синхронизации каталога вернут запись, что и было самой
  // болью: «удаляю — а оно возвращается». UPSERT, а не INSERT — на случай
  // повторного DELETE по той же паре.
  const { error: denylistErr } = await supabaseInstantly
    .from('project_instantly_campaigns_denylist')
    .upsert(
      { project_id: projectId, campaign_id: campaignId },
      { onConflict: 'project_id,campaign_id' },
    );
  if (denylistErr) {
    console.error('[campaigns/DELETE] denylist write failed', denylistErr.message);
    // Не валим запрос: основная работа (DELETE из project_instantly_campaigns)
    // прошла. Худшее что случится — авто-матчер вернёт запись на следующей
    // синке, и пользователю придётся удалить ещё раз. Это лучше чем 500.
  }

  return NextResponse.json({ ok: true });
}

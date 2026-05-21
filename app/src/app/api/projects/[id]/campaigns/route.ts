import { NextRequest, NextResponse } from 'next/server';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

type ActivePeriod = {
  id: string;
  period_start: string | null;
};

async function getActivePeriod(projectId: string): Promise<ActivePeriod | null> {
  if (!supabaseAdmin) return null;
  const { data } = await supabaseAdmin
    .from('project_periods')
    .select('id, period_start')
    .eq('project_id', projectId)
    .eq('status', 'active')
    .maybeSingle();
  return (data as ActivePeriod | null) ?? null;
}

function campaignStartsInsidePeriod(
  campaign: { timestamp_created?: string | null },
  period: ActivePeriod,
): boolean {
  if (!period.period_start) return true;
  const campaignMs = Date.parse(campaign.timestamp_created ?? '');
  const periodMs = Date.parse(period.period_start);
  if (!Number.isFinite(campaignMs) || !Number.isFinite(periodMs)) return false;
  return campaignMs >= periodMs;
}

async function getCampaignBaseline(campaignId: string, activePeriod: ActivePeriod): Promise<number> {
  if (!supabaseInstantly) return 0;
  const { data } = await supabaseInstantly
    .from('instantly_campaign_catalog')
    .select('id, timestamp_created, new_leads_contacted_count')
    .eq('id', campaignId)
    .maybeSingle();
  if (!data) return 0;
  if (campaignStartsInsidePeriod(data as { timestamp_created?: string | null }, activePeriod)) {
    return 0;
  }
  const n = Number((data as { new_leads_contacted_count?: number | null }).new_leads_contacted_count);
  return Number.isFinite(n) ? n : 0;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  if (!supabaseInstantly) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }
  const activePeriod = await getActivePeriod(projectId);

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

  return NextResponse.json({ items, activePeriod });
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

  const activePeriod = await getActivePeriod(projectId);
  const baseline = activePeriod ? await getCampaignBaseline(body.campaign_id, activePeriod) : 0;
  const { error } = activePeriod
    ? await supabaseInstantly
        .from('project_period_instantly_campaigns')
        .upsert(
          {
            project_id: projectId,
            period_id: activePeriod.id,
            campaign_id: body.campaign_id,
            match_source: 'manual',
            baseline_contacts: baseline,
          },
          { onConflict: 'period_id,campaign_id' },
        )
    : await supabaseInstantly
        .from('project_instantly_campaigns')
        .upsert(
          { project_id: projectId, campaign_id: body.campaign_id, match_source: 'manual' },
          { onConflict: 'project_id,campaign_id' },
        );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
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

  const activePeriod = await getActivePeriod(projectId);
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

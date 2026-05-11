import { NextRequest, NextResponse } from 'next/server';
import { supabaseInstantly } from '@/lib/supabaseInstantly';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  if (!supabaseInstantly) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const { data, error } = await supabaseInstantly
    .from('project_instantly_campaigns')
    .select('campaign_id, match_source, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });

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
  }));

  return NextResponse.json({ items });
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

  const { error } = await supabaseInstantly
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

  const { error } = await supabaseInstantly
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

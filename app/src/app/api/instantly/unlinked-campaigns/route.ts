import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { clientNameMatchScore, isApproximateClientNameMatch } from '@/lib/tools/instantlyCampaignCatalog';

export const dynamic = 'force-dynamic';

/** Потолок выдачи: кампаний тысячи, а разбирают их десятками. */
const MAX_ROWS = 300;

interface CatalogRow {
  id: string;
  name: string | null;
  timestamp_created: string | null;
  new_leads_contacted_count: number | null;
  instantly_account_id: string | null;
}

/**
 * Кампании Instantly, не привязанные ни к одному проекту. Раньше такие просто
 * пропадали: автопривязка их пропускала (спорное имя или имени проекта в
 * названии нет вовсе), а в портале они не показывались нигде — кампания
 * «висела в базе», и её ответы не доходили до специалиста.
 *
 * Отдаём вместе с подсказкой, каким проектам подходит название, чтобы
 * привязать можно было в один клик.
 */
export const GET = withAuth(async (req: NextRequest) => {
  if (!supabaseAdmin || !supabaseInstantly) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }
  const search = (new URL(req.url).searchParams.get('q') ?? '').trim().toLowerCase();

  const [catalog, legacy, period, denylist, projects] = await Promise.all([
    supabaseInstantly
      .from('instantly_campaign_catalog')
      .select('id, name, timestamp_created, new_leads_contacted_count, instantly_account_id'),
    supabaseInstantly.from('project_instantly_campaigns').select('campaign_id'),
    supabaseInstantly.from('project_period_instantly_campaigns').select('campaign_id'),
    supabaseInstantly.from('project_instantly_campaigns_denylist').select('campaign_id, project_id'),
    supabaseAdmin.from('projects').select('id, client, name, status').not('client', 'is', null),
  ]);

  const firstError = catalog.error ?? legacy.error ?? period.error ?? denylist.error ?? projects.error;
  if (firstError) {
    return NextResponse.json({ error: firstError.message }, { status: 500 });
  }

  const linked = new Set<string>();
  for (const row of [...(legacy.data ?? []), ...(period.data ?? [])]) {
    if (row.campaign_id) linked.add(row.campaign_id as string);
  }

  const projectRows = (projects.data ?? []).map((p) => ({
    id: p.id as string,
    client: ((p.client as string) ?? '').trim(),
    status: (p.status as string) ?? '',
  })).filter((p) => p.client.length >= 2);
  const clientById = new Map(projectRows.map((p) => [p.id, p.client]));

  // Кампанию, которую специалист сам убрал из карточки, показываем с пометкой:
  // это не потеря, а решение — иначе список выглядел бы вечно недоделанным.
  const removedBy = new Map<string, string[]>();
  for (const row of denylist.data ?? []) {
    const campaignId = row.campaign_id as string;
    const client = clientById.get(row.project_id as string);
    if (!campaignId || !client) continue;
    removedBy.set(campaignId, [...(removedBy.get(campaignId) ?? []), client]);
  }

  const unlinked = (catalog.data ?? [])
    .map((row) => row as CatalogRow)
    .filter((row) => !linked.has(row.id))
    .filter((row) => !search || (row.name ?? '').toLowerCase().includes(search));

  const rows = unlinked
    .sort((a, b) => (b.timestamp_created ?? '').localeCompare(a.timestamp_created ?? ''))
    .slice(0, MAX_ROWS)
    .map((row) => ({
      id: row.id,
      name: row.name ?? '',
      createdAt: row.timestamp_created,
      contacted: row.new_leads_contacted_count ?? 0,
      accountId: row.instantly_account_id ?? 'main',
      removedBy: removedBy.get(row.id) ?? [],
      // Проекты, чьё имя звучит в названии кампании, — те самые «спорные»,
      // из-за которых автопривязка отказалась выбирать сама. Плюс похожие с
      // точностью до опечатки: «Евмаркетиг стоматологии» → «Евмаркетинг».
      suggestions: projectRows
        .map((p) => {
          const score = clientNameMatchScore(row.name ?? '', p.client);
          const approximate = score === 0 && isApproximateClientNameMatch(row.name ?? '', p.client);
          return { id: p.id, client: p.client, status: p.status, score, approximate };
        })
        .filter((p) => p.score > 0 || p.approximate)
        .sort((a, b) => b.score - a.score || a.client.localeCompare(b.client, 'ru'))
        .slice(0, 5),
    }));

  return NextResponse.json({
    rows,
    total: unlinked.length,
    projects: projectRows
      .map((p) => ({ id: p.id, client: p.client, status: p.status }))
      .sort((a, b) => a.client.localeCompare(b.client, 'ru')),
  });
});

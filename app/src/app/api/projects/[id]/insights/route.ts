import { NextRequest, NextResponse } from 'next/server';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { buildProjectInsights } from '@/lib/instantly/projectInsights';
import { isDatasetConfigured, refreshAbIfStale } from '@/lib/instantlyDataset';

export const dynamic = 'force-dynamic';

/**
 * GET /api/projects/[id]/insights
 * Honest campaign-insights for a project's linked Instantly campaigns.
 * Resolves campaign ids the same way as /api/projects/[id]/campaigns
 * (active-period table when there is an active period, else project map),
 * then computes metrics against the analytics dataset DB. No AI at render.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  if (!supabaseInstantly) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }
  if (!isDatasetConfigured()) {
    return NextResponse.json({ error: 'Dataset not configured', insights: null }, { status: 200 });
  }

  // active period (if any) decides which mapping table to read — mirrors campaigns route
  let activePeriodId: string | null = null;
  if (supabaseAdmin) {
    const { data } = await supabaseAdmin
      .from('project_periods')
      .select('id')
      .eq('project_id', projectId)
      .eq('status', 'active')
      .maybeSingle();
    activePeriodId = (data as { id: string } | null)?.id ?? null;
  }

  const { data, error } = activePeriodId
    ? await supabaseInstantly
        .from('project_period_instantly_campaigns')
        .select('campaign_id')
        .eq('period_id', activePeriodId)
    : await supabaseInstantly
        .from('project_instantly_campaigns')
        .select('campaign_id')
        .eq('project_id', projectId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const campaignIds = (data ?? []).map((r) => r.campaign_id as string).filter(Boolean);
  if (campaignIds.length === 0) {
    return NextResponse.json({ insights: null, reason: 'no_campaigns' });
  }

  // keep the A/B materialized view fresh without a prod cron (fire-and-forget)
  void refreshAbIfStale();

  try {
    const insights = await buildProjectInsights(campaignIds);
    return NextResponse.json({ insights });
  } catch (e) {
    console.error('[projects/insights] build failed:', (e as Error).message);
    return NextResponse.json({ error: 'insights_failed', insights: null }, { status: 200 });
  }
}

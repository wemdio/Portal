import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { filterAllowedIds } from '@/lib/clientAccess';
import { getCampaignAnalytics, listAllCampaigns } from '@/lib/instantly/client';
import type { CampaignAnalytics } from '@/lib/instantly/types';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  const { accessRows } = result.auth;

  const allowedCampaignIds = filterAllowedIds([], accessRows, 'campaign');
  if (allowedCampaignIds.length === 0) {
    return NextResponse.json({ campaigns: [], analytics: [] });
  }

  try {
    const [analyticsData, allCampaigns] = await Promise.all([
      getCampaignAnalytics({}).catch(() => [] as CampaignAnalytics[]),
      listAllCampaigns(),
    ]);

    const analyticsArr = Array.isArray(analyticsData) ? analyticsData : [];
    const allowedSet = new Set(allowedCampaignIds);

    const campaigns = allCampaigns.filter((c) => allowedSet.has(c.id));
    const analytics = analyticsArr.filter(
      (a) => a.campaign_id && allowedSet.has(a.campaign_id),
    );

    return NextResponse.json({ campaigns, analytics });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка загрузки';
    return jsonError(message, 500);
  }
}

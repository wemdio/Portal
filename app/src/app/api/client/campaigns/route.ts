import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { filterAllowedIds } from '@/lib/clientAccess';
import { getCampaignAnalytics, listAllCampaigns } from '@/lib/instantly/client';
import type { Campaign, CampaignAnalytics } from '@/lib/instantly/types';
import { cached } from '@/lib/clientCache';

export const dynamic = 'force-dynamic';

const CAMPAIGNS_TTL = 5 * 60 * 1000;
const ANALYTICS_TTL = 5 * 60 * 1000;

export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  const { accessRows } = result.auth;

  const allowedCampaignIds = filterAllowedIds([], accessRows, 'campaign');
  if (allowedCampaignIds.length === 0) {
    return NextResponse.json({ campaigns: [], analytics: [] });
  }

  try {
    const [allCampaigns, analyticsData] = await Promise.all([
      cached<Campaign[]>('instantly:campaigns:all', () => listAllCampaigns(), CAMPAIGNS_TTL),
      cached<CampaignAnalytics[]>(
        'instantly:analytics:all',
        () => getCampaignAnalytics({}).catch(() => [] as CampaignAnalytics[]),
        ANALYTICS_TTL,
      ),
    ]);

    const allowedSet = new Set(allowedCampaignIds);
    const campaigns = allCampaigns.filter((c) => allowedSet.has(c.id));
    const analytics = (Array.isArray(analyticsData) ? analyticsData : []).filter(
      (a) => a.campaign_id && allowedSet.has(a.campaign_id),
    );

    return NextResponse.json({ campaigns, analytics });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка загрузки';
    return jsonError(message, 500);
  }
}

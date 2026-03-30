import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { isResourceAllowed } from '@/lib/clientAccess';
import {
  getCampaign,
  getCampaignAnalytics,
  getCampaignAnalyticsSteps,
} from '@/lib/instantly/client';
import { cached } from '@/lib/clientCache';

export const dynamic = 'force-dynamic';

const DETAIL_TTL = 5 * 60 * 1000;

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  const { accessRows } = result.auth;

  const { id: campaignId } = await ctx.params;

  if (!isResourceAllowed(campaignId, accessRows, 'campaign')) {
    return jsonError('Кампания не найдена или доступ запрещён', 404);
  }

  try {
    const [campaign, analyticsData, stepsData] = await Promise.all([
      cached(`instantly:campaign:${campaignId}`, () => getCampaign(campaignId), DETAIL_TTL),
      cached(
        `instantly:analytics:${campaignId}`,
        () => getCampaignAnalytics({ campaign_id: campaignId }).catch(() => []),
        DETAIL_TTL,
      ),
      cached(
        `instantly:steps:${campaignId}`,
        () => getCampaignAnalyticsSteps({ campaign_id: campaignId }).catch(() => []),
        DETAIL_TTL,
      ),
    ]);

    const analyticsArr = Array.isArray(analyticsData) ? analyticsData : [];
    const analytics = analyticsArr.find(
      (a) => a.campaign_id === campaignId || (a as Record<string, unknown>).id === campaignId,
    ) ?? null;

    const stepsArr = Array.isArray(stepsData) ? stepsData : [];
    const steps = stepsArr
      .filter((item) => {
        const stepVal = String(item.step ?? '');
        return stepVal !== '\\N' && stepVal !== 'null' && stepVal !== '';
      })
      .map((item) => ({
        ...item,
        step: Number(item.step) || 0,
        variant: Number(item.variant) || 0,
      }))
      .sort((a, b) => a.step - b.step || a.variant - b.variant);

    return NextResponse.json({ campaign, analytics, steps });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка загрузки';
    return jsonError(message, 500);
  }
}

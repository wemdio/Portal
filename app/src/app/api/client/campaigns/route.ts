import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { filterAllowedIds } from '@/lib/clientAccess';
import { readCampaignAnalyticsFromDb } from '@/lib/tools/instantlyCampaignCatalog';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  const { accessRows } = result.auth;

  const allowedCampaignIds = filterAllowedIds([], accessRows, 'campaign');
  if (allowedCampaignIds.length === 0) {
    return NextResponse.json({ total: 0, campaigns: [], lastSyncedAt: null });
  }

  try {
    const { campaigns, lastSyncedAt } = await readCampaignAnalyticsFromDb(allowedCampaignIds);

    return NextResponse.json({
      total: allowedCampaignIds.length,
      campaigns,
      lastSyncedAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка загрузки';
    return jsonError(message, 500);
  }
}

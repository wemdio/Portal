import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { getResourceInstantlyAccountId, isResourceAllowed } from '@/lib/clientAccess';
import { pauseCampaign } from '@/lib/instantly/client';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { logAudit, logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  const { userId, accessRows } = result.auth;
  const { id: campaignId } = await ctx.params;

  if (!isResourceAllowed(campaignId, accessRows, 'campaign')) {
    return jsonError('Кампания не найдена или доступ запрещён', 404);
  }

  try {
    await pauseCampaign(campaignId, {
      accountId: getResourceInstantlyAccountId(campaignId, accessRows, 'campaign'),
    });

    if (supabaseInstantly) {
      await supabaseInstantly
        .from('client_campaign_launches')
        .update({ status: 'paused' })
        .eq('client_user_id', userId)
        .eq('instantly_campaign_id', campaignId);
    }

    await logAudit('client.campaign.pause', 'Client paused campaign', { campaignId }, { userId });
    return NextResponse.json({ ok: true, status: 'paused' });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Не удалось поставить на паузу';
    await logError('client.campaign.pause.failed', err, { campaignId }, { userId });
    return jsonError(message, 500);
  }
}

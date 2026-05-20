import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { serveClientDemo } from '@/lib/clientDemo/demoResponse';
import { getResourceInstantlyAccountId, isResourceAllowed } from '@/lib/clientAccess';
import { listEmails } from '@/lib/instantly/client';
import { mapInstantlyEmailToReply } from '@/lib/clientCampaignReplies/mapEmail';
import type { ClientRepliesPage } from '@/lib/clientCampaignReplies/types';
import { logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/**
 * GET /api/client/campaigns/[id]/replies
 *   ?limit=25
 *   &starting_after=<instantly cursor>
 *   &search=<query>  (optional — Instantly's free-text search across emails)
 *
 * Returns all lead replies (ue_type=2) for the campaign, sanitized via
 * mapInstantlyEmailToReply. Client must own the campaign via client_instantly_access.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (result.auth.isDemo) return serveClientDemo(req);
  const { accessRows } = result.auth;

  const { id: campaignId } = await ctx.params;
  if (!isResourceAllowed(campaignId, accessRows, 'campaign')) {
    return jsonError('Кампания не найдена или доступ запрещён', 404);
  }

  const url = new URL(req.url);
  const rawLimit = parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, MAX_LIMIT)
    : DEFAULT_LIMIT;
  const startingAfter = url.searchParams.get('starting_after') || undefined;
  const search = url.searchParams.get('search')?.trim() || undefined;

  try {
    const data = await listEmails({
      campaign_id: campaignId,
      ue_type: 2, // 2 = reply from lead
      limit,
      starting_after: startingAfter,
      search,
    }, {
      accountId: getResourceInstantlyAccountId(campaignId, accessRows, 'campaign'),
    });

    const items = (data.items ?? []).map(mapInstantlyEmailToReply);
    const payload: ClientRepliesPage = {
      items,
      next_starting_after: data.next_starting_after ?? null,
    };
    return NextResponse.json(payload);
  } catch (err) {
    await logError('client.campaign.replies.failed', err, { campaignId });
    return jsonError(err instanceof Error ? err.message : 'Не удалось загрузить ответы', 502);
  }
}

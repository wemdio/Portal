import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { isResourceAllowed } from '@/lib/clientAccess';
import { getEmail, listEmails } from '@/lib/instantly/client';
import { mapInstantlyEmailToThreadMessage } from '@/lib/clientCampaignReplies/mapEmail';
import type { ClientReplyThread } from '@/lib/clientCampaignReplies/types';
import { logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

const THREAD_FETCH_LIMIT = 100;

/**
 * GET /api/client/campaigns/[id]/replies/[emailId]/thread
 *
 * Returns the full conversation thread for a given lead reply, sorted
 * chronologically. Inbound (lead) and outbound (our) messages are both included.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; emailId: string }> },
) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  const { accessRows } = result.auth;

  const { id: campaignId, emailId } = await ctx.params;
  if (!isResourceAllowed(campaignId, accessRows, 'campaign')) {
    return jsonError('Кампания не найдена или доступ запрещён', 404);
  }

  try {
    const original = await getEmail(emailId);
    if (!original || original.campaign_id !== campaignId) {
      return jsonError('Письмо не относится к кампании', 404);
    }

    const threadId = original.thread_id ?? null;
    const leadId = original.lead ?? null;

    let candidates = [original];
    if (threadId && leadId) {
      const list = await listEmails({ campaign_id: campaignId, lead_id: leadId, limit: THREAD_FETCH_LIMIT });
      candidates = (list.items ?? []).filter((e) => e.thread_id === threadId);
      // Ensure original is in the list (in case API didn't return it).
      if (!candidates.some((e) => e.id === original.id)) {
        candidates.unshift(original);
      }
    }

    const messages = candidates.map(mapInstantlyEmailToThreadMessage).sort((a, b) => {
      const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
      const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
      return ta - tb;
    });

    const payload: ClientReplyThread = {
      thread_id: threadId,
      messages,
    };
    return NextResponse.json(payload);
  } catch (err) {
    await logError('client.campaign.replies.thread.failed', err, { campaignId, emailId });
    return jsonError(err instanceof Error ? err.message : 'Не удалось загрузить тред', 502);
  }
}

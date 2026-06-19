import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { serveClientDemo } from '@/lib/clientDemo/demoResponse';
import { getResourceInstantlyAccountId, isResourceAllowed } from '@/lib/clientAccess';
import { getEmail, listEmails } from '@/lib/instantly/client';
import { mapInstantlyEmailToThreadMessage } from '@/lib/clientCampaignReplies/mapEmail';
import { recordEmailRead } from '@/lib/clientCampaignReplies/clientEmailReads';
import type { ClientReplyThread } from '@/lib/clientCampaignReplies/types';
import { logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

const THREAD_FETCH_LIMIT = 100;

/**
 * GET /api/client/campaigns/[id]/replies/[emailId]/thread
 *
 * Returns the full conversation thread for a given lead reply, sorted
 * newest-first (most recent message on top, like Instantly's unibox). Inbound
 * (lead) and outbound (our) messages are both included.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; emailId: string }> },
) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (result.auth.isDemo) return serveClientDemo(req);
  const { userId, accessRows } = result.auth;

  const { id: campaignId, emailId } = await ctx.params;
  if (!isResourceAllowed(campaignId, accessRows, 'campaign')) {
    return jsonError('Кампания не найдена или доступ запрещён', 404);
  }
  const instantlyRequestOptions = {
    accountId: getResourceInstantlyAccountId(campaignId, accessRows, 'campaign'),
  };

  try {
    const original = await getEmail(emailId, instantlyRequestOptions);
    if (!original || original.campaign_id !== campaignId) {
      return jsonError('Письмо не относится к кампании', 404);
    }

    const threadId = original.thread_id ?? null;
    const leadId = original.lead ?? null;

    let candidates = [original];
    if (threadId && leadId) {
      const list = await listEmails({ campaign_id: campaignId, lead_id: leadId, limit: THREAD_FETCH_LIMIT }, instantlyRequestOptions);
      candidates = (list.items ?? []).filter((e) => e.thread_id === threadId);
      // Ensure original is in the list (in case API didn't return it).
      if (!candidates.some((e) => e.id === original.id)) {
        candidates.unshift(original);
      }
    }

    // Свежие сверху (tb - ta) — как в юнибоксе Instantly: последний шаг переписки
    // наверху, прокручиваешь вниз к началу диалога. Так верх ленты совпадает с
    // закреплённым блоком «ответ лида» в /replies (тоже последний шаг).
    const messages = candidates.map(mapInstantlyEmailToThreadMessage).sort((a, b) => {
      const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
      const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
      return tb - ta;
    });

    // Помечаем прочитанным ТОЛЬКО это письмо и ТОЛЬКО для этого клиента (наша
    // таблица), а НЕ весь тред в Instantly — иначе соседние ответы лида гасли бы
    // «непрочитано» без ведома клиента. См. clientEmailReads.
    try {
      await recordEmailRead(userId, emailId);
    } catch (err) {
      await logError('client.campaign.replies.thread.record_read_failed', err, {
        campaignId,
        emailId,
        userId,
      });
    }

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

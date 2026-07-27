import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { serveClientDemo } from '@/lib/clientDemo/demoResponse';
import { getResourceInstantlyAccountId, isResourceAllowed } from '@/lib/clientAccess';
import { listEmails } from '@/lib/instantly/client';
import { mapInstantlyEmailToReply } from '@/lib/clientCampaignReplies/mapEmail';
import { getReadEmailIds } from '@/lib/clientCampaignReplies/clientEmailReads';
import { filterForeignEmails, resolveClientMailboxes } from '@/lib/clientCampaignReplies/foreignMailboxFilter';
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
  const { accessRows, userId } = result.auth;

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
    const accountId = getResourceInstantlyAccountId(campaignId, accessRows, 'campaign');
    const data = await listEmails({
      campaign_id: campaignId,
      // Instantly v2 фильтрует по `email_type`, а не `ue_type` (ue_type —
      // это поле в ответе). Без этого Instantly игнорил наш фильтр и
      // возвращал все письма по кампании — и входящие, и наши же
      // исходящие первые шаги.
      email_type: 'received',
      limit,
      starting_after: startingAfter,
      search,
    }, { accountId });

    // Кросс-клиентская гигиена: Instantly клеит входящее к кампании по адресу
    // отправителя, не проверяя получателя — письма, пришедшие на ящик ДРУГОГО
    // клиента воркспейса, всплывают в ответах этой кампании. Показываем только
    // письма, полученные ящиками этого клиента (email_list кампании ∪ пул из
    // пресетов/запусков); чужие скрываем (см. foreignMailboxFilter).
    const mailboxes = await resolveClientMailboxes(userId, campaignId, accountId);
    const visible = await filterForeignEmails(data.items ?? [], mailboxes, { campaignId, userId });

    const items = visible.map(mapInstantlyEmailToReply);
    // «NEW»-бейдж берём из НАШЕЙ персональной прочитанности (client_email_reads),
    // а не из общего флага Instantly: портал больше не вызывает markThreadAsRead,
    // поэтому is_unread из Instantly здесь иначе залипал бы навсегда (как и в
    // мигрированном /api/client/replies).
    const readSet = await getReadEmailIds(userId, items.map((i) => i.id));
    for (const it of items) it.is_unread = !readSet.has(it.id);
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

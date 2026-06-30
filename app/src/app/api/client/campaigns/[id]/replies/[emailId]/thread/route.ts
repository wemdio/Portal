import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { serveClientDemo } from '@/lib/clientDemo/demoResponse';
import { getResourceInstantlyAccountId, isResourceAllowed } from '@/lib/clientAccess';
import { getEmail, listEmails } from '@/lib/instantly/client';
import { mapInstantlyEmailToThreadMessage } from '@/lib/clientCampaignReplies/mapEmail';
import { findEaccountForReply } from '@/lib/clientCampaignReplies/findEaccount';
import { computeReplyAllRecipients } from '@/lib/clientCampaignReplies/participants';
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

    // Помечаем прочитанным СРАЗУ после проверки доступа — ДО загрузки треда. Если
    // listEmails ниже упадёт (Instantly затупил → роут отдаст 502), пометка
    // прочтения всё равно сохранится, иначе открытая переписка «отпрочитывалась» бы
    // на перезагрузке и расходилась с оптимистичным is_unread=false в UI. Метим
    // ТОЛЬКО это письмо и ТОЛЬКО для этого клиента (НЕ markThreadAsRead в Instantly,
    // иначе соседние ответы лида гасли бы без ведома клиента). См. clientEmailReads.
    try {
      await recordEmailRead(userId, emailId);
    } catch (err) {
      await logError('client.campaign.replies.thread.record_read_failed', err, {
        campaignId,
        emailId,
        userId,
      });
    }

    const threadId = original.thread_id ?? null;
    const leadEmail = original.lead ?? null;

    // Тянем ВСЮ переписку с лидом в этой кампании, фильтруя по `lead` (email) —
    // это рабочий фильтр Instantly. Раньше передавали `lead_id` с email-значением,
    // но Instantly его игнорирует и отдаёт письма ВСЕЙ кампании, после чего мы
    // сужали по thread_id. А Instantly ещё и дробит один диалог на разные
    // thread_id (смена темы, reply-all, тред в почтовике лида) — фильтр по одному
    // thread_id терял часть истории, и диалог выглядел «обрезанным». Берём все
    // письма лида (любой thread_id, до THREAD_FETCH_LIMIT=100 последних — запас
    // большой, макс. встречено ~24/лид) = полная переписка. Лимит теперь per-lead,
    // а не per-campaign, поэтому окно лиду больше не «съедают» чужие письма.
    // (Проверено живьём 2026-06-19.)
    let candidates = [original];
    if (leadEmail) {
      const list = await listEmails(
        { campaign_id: campaignId, lead: leadEmail, limit: THREAD_FETCH_LIMIT },
        instantlyRequestOptions,
      );
      const items = list.items ?? [];
      if (items.length > 0) {
        candidates = items.some((e) => e.id === original.id) ? items : [original, ...items];
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

    // Reply preview for the composer: who a reply goes TO (the lead) and who is
    // auto-kept in CC («ответить всем») — the same set the reply route applies,
    // so the client SEES exactly who stays in copy before sending.
    const eaccount = findEaccountForReply({ originalEmail: original, threadEmails: candidates });
    const fromName =
      Array.isArray(original.from_address_json) && typeof original.from_address_json[0]?.name === 'string'
        ? original.from_address_json[0].name.trim() || null
        : null;
    const replyToEmail = original.from_address_email ?? leadEmail ?? null;
    const reply_to = replyToEmail ? { email: replyToEmail, name: fromName } : null;
    const reply_all_cc = computeReplyAllRecipients(original, { eaccount, leadEmail });

    const payload: ClientReplyThread = {
      thread_id: threadId,
      messages,
      reply_to,
      reply_all_cc,
    };
    return NextResponse.json(payload);
  } catch (err) {
    await logError('client.campaign.replies.thread.failed', err, { campaignId, emailId });
    return jsonError(err instanceof Error ? err.message : 'Не удалось загрузить тред', 502);
  }
}

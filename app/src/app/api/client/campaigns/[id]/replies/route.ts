import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { serveClientDemo } from '@/lib/clientDemo/demoResponse';
import { getResourceInstantlyAccountId, isResourceAllowed } from '@/lib/clientAccess';
import { listEmails } from '@/lib/instantly/client';
import { mapInstantlyEmailToReply } from '@/lib/clientCampaignReplies/mapEmail';
import { getReadEmailIds } from '@/lib/clientCampaignReplies/clientEmailReads';
import { filterForeignEmails, normalizeMailbox, resolveClientMailboxes } from '@/lib/clientCampaignReplies/foreignMailboxFilter';
import { looksLikeEmail } from '@/lib/clientCampaignReplies/repliesWindow';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import type { ClientReply, ClientRepliesPage } from '@/lib/clientCampaignReplies/types';
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
    let savedSearchFailed = false;
    let savedItems: ClientReply[] = [];
    // Search the durable reply index first. Instantly's email search does not
    // include replies it associated with another campaign, and the normal feed
    // only contains a recent page. Both make older/stray dialogues disappear.
    if (search && looksLikeEmail(search) && supabaseInstantly) {
      const { data: saved, error: savedError } = await supabaseInstantly
        .from('instantly_lead_qualifications')
        .select('instantly_email_id, lead_email, lead_name, reply_subject, reply_preview, reply_body, reply_timestamp, created_at, thread_id, eaccount, reply_out_of_campaign')
        .eq('campaign_id', campaignId)
        .ilike('lead_email', search.toLowerCase())
        .is('machine_reply_kind', null)
        .not('instantly_email_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(MAX_LIMIT);
      if (savedError) {
        savedSearchFailed = true;
        await logError('client.campaign.replies.saved_search_failed', savedError, { campaignId });
      } else if (saved?.length) {
        const mailboxes = await resolveClientMailboxes(userId, campaignId, accountId);
        const exact = search.toLowerCase();
        const rows = saved.filter((row) => {
          const mailbox = normalizeMailbox(row.eaccount);
          if (row.lead_email?.trim().toLowerCase() !== exact) return false;
          // Linked replies already belong to this campaign. Older records
          // often have no eaccount, so use the live feed's foreign-mailbox
          // rule. Strays need positive mailbox ownership (strayAccess).
          if (row.reply_out_of_campaign) return Boolean(mailbox && mailboxes?.has(mailbox));
          return !mailbox || !mailboxes || mailboxes.has(mailbox);
        });
        if (rows.length > 0) {
          savedItems = rows.map((row) => ({
            id: row.instantly_email_id,
            timestamp: row.reply_timestamp ?? row.created_at,
            subject: row.reply_subject,
            from_email: row.lead_email,
            from_name: row.lead_name,
            lead_id: null,
            thread_id: row.thread_id,
            is_unread: false,
            ai_interest_value: null,
            content_preview: row.reply_preview?.slice(0, 200) ?? null,
            body_text: row.reply_body?.slice(0, 20_000) ?? null,
            out_of_campaign: row.reply_out_of_campaign === true,
          }));
        }
      }
    }
    // Одно чтение одной кампании на действие человека (вкладка «Ответы»,
    // поиск, «ещё») — людская доля бюджета чтения (requestPriority ниже), а не
    // фоновая: иначе при насыщенном фоне вкладка ловила бы
    // «email read deferred: budget».
    let data: Awaited<ReturnType<typeof listEmails>>;
    try {
      data = await listEmails({
        campaign_id: campaignId,
        // Instantly v2 фильтрует по `email_type`, а не `ue_type` (ue_type —
        // это поле в ответе). Без этого Instantly игнорил наш фильтр и
        // возвращал все письма по кампании — и входящие, и наши же
        // исходящие первые шаги.
        email_type: 'received',
        limit,
        starting_after: startingAfter,
        search,
      }, { accountId, consumer: 'client_campaign_feed', requestPriority: 'interactive' });
    } catch (err) {
      if (savedItems.length === 0) throw err;
      await logError('client.campaign.replies.live_search_failed', err, { campaignId });
      data = { items: [], next_starting_after: undefined };
    }

    // Кросс-клиентская гигиена: Instantly клеит входящее к кампании по адресу
    // отправителя, не проверяя получателя — письма, пришедшие на ящик ДРУГОГО
    // клиента воркспейса, всплывают в ответах этой кампании. Показываем только
    // письма, полученные ящиками этого клиента (email_list кампании ∪ пул из
    // пресетов/запусков); чужие скрываем (см. foreignMailboxFilter).
    const mailboxes = await resolveClientMailboxes(userId, campaignId, accountId);
    const visible = await filterForeignEmails(data.items ?? [], mailboxes, { campaignId, userId });

    const liveItems = visible.map(mapInstantlyEmailToReply);
    if (savedSearchFailed && liveItems.length === 0) {
      return jsonError('Поиск ответов не завершён. Повторите через несколько секунд.', 503);
    }
    // Preserve fresh inbound replies that have not entered the qualification
    // index yet, while keeping older and out-of-campaign saved replies.
    const byId = new Map<string, ClientReply>();
    for (const item of savedItems) byId.set(item.id, item);
    for (const item of liveItems) byId.set(item.id, item);
    const items = [...byId.values()].sort((a, b) =>
      (b.timestamp ? Date.parse(b.timestamp) : 0) - (a.timestamp ? Date.parse(a.timestamp) : 0));
    // «NEW»-бейдж берём из НАШЕЙ персональной прочитанности (client_email_reads),
    // а не из общего флага Instantly: портал больше не вызывает markThreadAsRead,
    // поэтому is_unread из Instantly здесь иначе залипал бы навсегда (как и в
    // мигрированном /api/client/replies).
    const readSet = await getReadEmailIds(userId, items.map((i) => i.id));
    for (const it of items) it.is_unread = !readSet.has(it.id);
    const payload: ClientRepliesPage = {
      items: items.slice(0, limit),
      next_starting_after: savedItems.length > 0 ? null : data.next_starting_after ?? null,
    };
    return NextResponse.json(payload);
  } catch (err) {
    await logError('client.campaign.replies.failed', err, { campaignId });
    return jsonError(err instanceof Error ? err.message : 'Не удалось загрузить ответы', 502);
  }
}

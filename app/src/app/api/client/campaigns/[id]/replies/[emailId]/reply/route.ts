import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { getResourceInstantlyAccountId, isResourceAllowed } from '@/lib/clientAccess';
import { getEmail, listEmails, replyToEmail } from '@/lib/instantly/client';
import { findEaccountForReply } from '@/lib/clientCampaignReplies/findEaccount';
import { isForeignEmail, isInboundEmail, resolveClientMailboxes } from '@/lib/clientCampaignReplies/foreignMailboxFilter';
import { computeReplyAllCc, mergeCcLists } from '@/lib/clientCampaignReplies/participants';
import { validateReplyInput } from '@/lib/clientCampaignReplies/validate';
import { textToReplyHtml } from '@/lib/clientCampaignReplies/bodyHtml';
import { extractBodyText } from '@/lib/clientCampaignReplies/mapEmail';
import { appendQuotedHistoryText, appendQuotedHistoryHtml } from '@/lib/clientCampaignReplies/quoteHistory';
import { logAudit, logError } from '@/lib/loggerServer';
import { recordEmailReplied, recordEmailRead } from '@/lib/clientCampaignReplies/clientEmailReads';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

function buildReplySubject(subject?: string | null): string {
  const trimmed = subject?.trim();
  if (!trimmed) return 'Re:';
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

/**
 * POST /api/client/campaigns/[id]/replies/[emailId]/reply
 * Body: { body_text: string, cc?: string, bcc?: string }
 *
 * Sends a reply in the thread of the given lead-reply email. The sending account
 * (eaccount) is auto-detected from the original message or its thread.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; emailId: string }> },
) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  const { userId, accessRows } = result.auth;

  const { id: campaignId, emailId } = await ctx.params;
  if (!isResourceAllowed(campaignId, accessRows, 'campaign')) {
    return jsonError('Кампания не найдена или доступ запрещён', 404);
  }
  const instantlyRequestOptions = {
    accountId: getResourceInstantlyAccountId(campaignId, accessRows, 'campaign'),
  };

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError('Невалидный JSON', 400);
  }

  const raw = (body ?? {}) as Record<string, unknown>;
  const validation = validateReplyInput({ body_text: raw.body_text, cc: raw.cc, bcc: raw.bcc });
  if (!validation.ok) return jsonError(validation.error ?? 'Bad request', 400);

  try {
    const original = await getEmail(emailId, instantlyRequestOptions);
    if (!original || original.campaign_id !== campaignId) {
      return jsonError('Письмо не относится к кампании', 404);
    }

    // Чужое входящее (получено ящиком ДРУГОГО клиента воркспейса, см.
    // foreignMailboxFilter): отвечать на него нельзя — findEaccountForReply
    // взял бы eaccount этого письма, и ответ ушёл бы С ЧУЖОГО ЯЩИКА, а его
    // содержимое (цитата) уехало бы лиду. Тот же 404, что для чужой кампании.
    if (isInboundEmail(original)) {
      const mailboxes = await resolveClientMailboxes(userId, campaignId, instantlyRequestOptions.accountId);
      if (isForeignEmail(original, mailboxes)) {
        return jsonError('Письмо не относится к кампании', 404);
      }
    }

    let eaccount = findEaccountForReply({ originalEmail: original, threadEmails: [] });
    if (!eaccount && original.thread_id && original.lead) {
      const thread = await listEmails({ campaign_id: campaignId, lead_id: original.lead, limit: 100 }, instantlyRequestOptions);
      eaccount = findEaccountForReply({ originalEmail: original, threadEmails: thread.items ?? [] });
    }
    if (!eaccount) {
      return jsonError('Не удалось определить аккаунт отправки. Попробуйте позже.', 400);
    }

    // «Ответить всем» по умолчанию: сохраняем всех, кого лид завёл в тред (То/CC
    // исходного письма, кроме нашего ящика и самого лида — он уйдёт в «Кому» через
    // reply_to_uuid), плюс то, что клиент дописал в CC руками. Иначе подключённого
    // лидом коллегу/ЛПР молча теряем (был инцидент: лид добавил линейного
    // продюсера, наш ответ ушёл без него, лид написал «вы удалили из копии»).
    const replyAllCc = computeReplyAllCc(original, { eaccount, leadEmail: original.lead });
    const manualCc = validation.cc ? validation.cc.split(',') : [];
    const mergedCc = mergeCcLists(replyAllCc, manualCc);

    // Цитируем письмо лида в тело: добавленный в CC коллега (Настя) — новый в
    // треде, Instantly не подкладывает ему прошлую переписку, иначе он видит
    // наш ответ без контекста. См. quoteHistory (инцидент 09.07).
    const quoteSrc = {
      bodyText: extractBodyText(original.body),
      fromName: original.from_address_json?.[0]?.name ?? null,
      fromEmail: original.from_address_email ?? original.lead ?? null,
      timestamp: original.timestamp_email ?? original.timestamp_created ?? null,
    };

    await replyToEmail(
      {
        reply_to_uuid: emailId,
        eaccount,
        subject: buildReplySubject(original.subject),
        // HTML с <br> сохраняет переносы строк (иначе письмо уходит «простынёй»);
        // text — plain-text fallback. К обоим дописываем процитированную историю.
        body: {
          html: appendQuotedHistoryHtml(textToReplyHtml(validation.body_text!), quoteSrc),
          text: appendQuotedHistoryText(validation.body_text!, quoteSrc),
        },
        ...(mergedCc.length ? { cc_address_email_list: mergedCc.join(', ') } : {}),
        ...(validation.bcc ? { bcc_address_email_list: validation.bcc } : {}),
      },
      instantlyRequestOptions,
    );

    // Фиксируем «отвечено» (бейдж «Отвечено» в списке) + «прочитано» (ответил =
    // прочитал) персонально для клиента. Best-effort — не валим отправку.
    try {
      // Пишем ключи переписки (campaign + lead), чтобы «Отвечено» считалось по
      // лиду и не слетало на объёмной кампании. См. applyRepliedMarks.
      await recordEmailReplied(userId, emailId, { campaignId, leadEmail: original.lead });
      await recordEmailRead(userId, emailId);
    } catch (err) {
      await logError('client.campaign.replies.reply.record_failed', err, { campaignId, emailId, userId });
    }

    void logAudit('client.campaign.replies.reply.sent', 'Client replied via Instantly', {
      campaignId,
      emailId,
      cc_count: mergedCc.length,
      bcc_count: validation.bcc ? validation.bcc.split(',').length : 0,
      userId,
    });

    // eaccount в ответ не отдаём: он клиенту не нужен, а для гипотетического
    // чужого письма это был бы адрес чужого ящика.
    return NextResponse.json({ ok: true });
  } catch (err) {
    await logError('client.campaign.replies.reply.failed', err, { campaignId, emailId, userId });
    return jsonError(err instanceof Error ? err.message : 'Не удалось отправить ответ', 502);
  }
}

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { getResourceInstantlyAccountId, isResourceAllowed } from '@/lib/clientAccess';
import { forwardEmail, getEmail, listEmails, sendTestEmail } from '@/lib/instantly/client';
import { isNotPartOfCampaignError } from '@/lib/instantly/notPartOfCampaign';
import { findEaccountForReply } from '@/lib/clientCampaignReplies/findEaccount';
import { resolveStrayAccess } from '@/lib/clientCampaignReplies/strayAccess';
import { isForeignEmail, isInboundEmail, resolveClientMailboxes } from '@/lib/clientCampaignReplies/foreignMailboxFilter';
import { validateForwardInput } from '@/lib/clientCampaignReplies/validate';
import { extractBodyText } from '@/lib/clientCampaignReplies/mapEmail';
import { buildForwardedMessageHtml } from '@/lib/clientCampaignReplies/quoteHistory';
import { logAudit, logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

function buildForwardSubject(subject?: string | null): string {
  const trimmed = subject?.trim();
  if (!trimmed) return 'Fwd:';
  return /^fwd?:/i.test(trimmed) ? trimmed : `Fwd: ${trimmed}`;
}

/**
 * POST /api/client/campaigns/[id]/replies/[emailId]/forward
 * Body: { to_email: string }
 *
 * Forwards a single email (1-to-1) via Instantly. The sending account is
 * auto-detected from the source email or its thread.
 *
 * «Сирота» (ответ, который провайдер не привязал к кампании) пересылается
 * тем же обходом, что и «Ответить»: право — по ящику-получателю (strayAccess,
 * fail-closed), отправка — НОВЫМ письмом тем же ящиком, потому что forward по
 * такому письму провайдер отвергает `400 … is not part of a campaign`.
 * Исходное письмо в этом случае вкладываем сами (buildForwardedMessageHtml).
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
  const validation = validateForwardInput({ to_email: raw.to_email });
  if (!validation.ok) return jsonError(validation.error ?? 'Bad request', 400);

  try {
    const original = await getEmail(emailId, instantlyRequestOptions);
    if (!original) {
      return jsonError('Письмо не относится к кампании', 404);
    }
    const isStray = original.campaign_id !== campaignId;
    let strayLeadEmail: string | null = null;
    if (isStray) {
      const stray = await resolveStrayAccess({
        emailId,
        campaignId,
        userId,
        accountId: instantlyRequestOptions.accountId,
        eaccount: original.eaccount,
      });
      if (!stray) return jsonError('Письмо не относится к кампании', 404);
      strayLeadEmail = stray.leadEmail;
    }
    const leadEmail = original.lead ?? strayLeadEmail;

    // Чужое входящее (получено ящиком ДРУГОГО клиента воркспейса, см.
    // foreignMailboxFilter): пересылать его нельзя — include_original_body
    // отправил бы содержимое чужой корреспонденции на произвольный адрес,
    // а eaccount письма — чужой ящик — стал бы отправителем.
    if (isInboundEmail(original)) {
      const mailboxes = await resolveClientMailboxes(userId, campaignId, instantlyRequestOptions.accountId);
      if (isForeignEmail(original, mailboxes)) {
        return jsonError('Письмо не относится к кампании', 404);
      }
    }

    let eaccount = findEaccountForReply({ originalEmail: original, threadEmails: [] });
    if (!eaccount && original.thread_id && leadEmail) {
      const thread = await listEmails({ campaign_id: campaignId, lead_id: leadEmail, limit: 100 }, { ...instantlyRequestOptions, consumer: 'client_forward', requestPriority: 'interactive' });
      eaccount = findEaccountForReply({ originalEmail: original, threadEmails: thread.items ?? [] });
    }
    if (!eaccount) {
      return jsonError('Не удалось определить аккаунт отправки. Попробуйте позже.', 400);
    }

    const subject = buildForwardSubject(original.subject);

    // Обход для писем вне кампании: НОВОЕ письмо тем же ящиком через
    // тест-эндпоинт, исходное письмо вкладываем сами. Плата та же, что у
    // «Ответить» по сироте: письмо не заводит сущность в Unibox провайдера,
    // но до адресата доходит.
    const sendAsNewLetter = async (): Promise<void> => {
      await sendTestEmail(
        {
          eaccount,
          to_address_email_list: validation.to_email!,
          subject,
          body: {
            html: buildForwardedMessageHtml({
              bodyText: extractBodyText(original.body),
              fromName: original.from_address_json?.[0]?.name ?? null,
              fromEmail: original.from_address_email ?? leadEmail ?? null,
              timestamp: original.timestamp_email ?? original.timestamp_created ?? null,
              subject: original.subject ?? null,
            }),
          },
        },
        instantlyRequestOptions,
      );
    };

    let via: 'forward' | 'test' = 'forward';
    if (isStray) {
      // По сироте forward отвергается гарантированно — не тратим на него
      // запрос: минутная квота воркспейса общая с воркерами.
      await sendAsNewLetter();
      via = 'test';
    } else {
      try {
        await forwardEmail(
          {
            reply_to_uuid: emailId,
            eaccount,
            to_address_email_list: validation.to_email!,
            subject,
            body: { text: '' },
            include_original_body: true,
          },
          instantlyRequestOptions,
        );
      } catch (err) {
        // Страховка: письмо числится в кампании, а провайдер считает иначе.
        if (!isNotPartOfCampaignError(err)) throw err;
        await sendAsNewLetter();
        via = 'test';
      }
    }

    void logAudit('client.campaign.replies.forward.sent', 'Client forwarded reply via Instantly', {
      campaignId,
      emailId,
      via,
      to_email: validation.to_email,
      userId,
    });

    // eaccount в ответ не отдаём: клиенту он не нужен, а для чужого
    // письма это был бы адрес чужого ящика.
    return NextResponse.json({ ok: true, to_email: validation.to_email });
  } catch (err) {
    await logError('client.campaign.replies.forward.failed', err, { campaignId, emailId, userId });
    return jsonError(err instanceof Error ? err.message : 'Не удалось переслать письмо', 502);
  }
}

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { isResourceAllowed } from '@/lib/clientAccess';
import { getEmail, listEmails, replyToEmail } from '@/lib/instantly/client';
import { findEaccountForReply } from '@/lib/clientCampaignReplies/findEaccount';
import { validateReplyInput } from '@/lib/clientCampaignReplies/validate';
import { logAudit, logError } from '@/lib/loggerServer';

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
    const original = await getEmail(emailId);
    if (!original || original.campaign_id !== campaignId) {
      return jsonError('Письмо не относится к кампании', 404);
    }

    let eaccount = findEaccountForReply({ originalEmail: original, threadEmails: [] });
    if (!eaccount && original.thread_id && original.lead) {
      const thread = await listEmails({ campaign_id: campaignId, lead_id: original.lead, limit: 100 });
      eaccount = findEaccountForReply({ originalEmail: original, threadEmails: thread.items ?? [] });
    }
    if (!eaccount) {
      return jsonError('Не удалось определить аккаунт отправки. Попробуйте позже.', 400);
    }

    await replyToEmail({
      reply_to_uuid: emailId,
      eaccount,
      subject: buildReplySubject(original.subject),
      body: { text: validation.body_text! },
      ...(validation.cc ? { cc_address_email_list: validation.cc } : {}),
      ...(validation.bcc ? { bcc_address_email_list: validation.bcc } : {}),
    });

    void logAudit('client.campaign.replies.reply.sent', 'Client replied via Instantly', {
      campaignId,
      emailId,
      cc_count: validation.cc ? validation.cc.split(',').length : 0,
      bcc_count: validation.bcc ? validation.bcc.split(',').length : 0,
      userId,
    });

    return NextResponse.json({ ok: true, eaccount });
  } catch (err) {
    await logError('client.campaign.replies.reply.failed', err, { campaignId, emailId, userId });
    return jsonError(err instanceof Error ? err.message : 'Не удалось отправить ответ', 502);
  }
}

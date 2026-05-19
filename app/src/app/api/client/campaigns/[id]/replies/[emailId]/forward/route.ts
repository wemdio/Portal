import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { isResourceAllowed } from '@/lib/clientAccess';
import { forwardEmail, getEmail, listEmails } from '@/lib/instantly/client';
import { findEaccountForReply } from '@/lib/clientCampaignReplies/findEaccount';
import { validateForwardInput } from '@/lib/clientCampaignReplies/validate';
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
  const validation = validateForwardInput({ to_email: raw.to_email });
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

    await forwardEmail({
      reply_to_uuid: emailId,
      eaccount,
      to_address_email_list: validation.to_email!,
      subject: buildForwardSubject(original.subject),
      body: { text: '' },
      include_original_body: true,
    });

    void logAudit('client.campaign.replies.forward.sent', 'Client forwarded reply via Instantly', {
      campaignId,
      emailId,
      to_email: validation.to_email,
      userId,
    });

    return NextResponse.json({ ok: true, eaccount, to_email: validation.to_email });
  } catch (err) {
    await logError('client.campaign.replies.forward.failed', err, { campaignId, emailId, userId });
    return jsonError(err instanceof Error ? err.message : 'Не удалось переслать письмо', 502);
  }
}

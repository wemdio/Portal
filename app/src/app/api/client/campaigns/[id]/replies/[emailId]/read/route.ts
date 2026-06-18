import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { isResourceAllowed } from '@/lib/clientAccess';
import { recordEmailRead, recordEmailUnread } from '@/lib/clientCampaignReplies/clientEmailReads';
import { logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/client/campaigns/[id]/replies/[emailId]/read
 * Body: { read: boolean }  — true = прочитано, false = снова непрочитано.
 *
 * Прочитанность хранится У НАС, ПОШТУЧНО и для конкретного клиента
 * (client_email_reads), а не в Instantly. Кнопка «пометить непрочитанным» в
 * портале шлёт { read: false }. См. clientEmailReads.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; emailId: string }> },
) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (result.auth.isDemo) return NextResponse.json({ ok: true, demo: true });
  const { userId, accessRows } = result.auth;

  const { id: campaignId, emailId } = await ctx.params;
  if (!isResourceAllowed(campaignId, accessRows, 'campaign')) {
    return jsonError('Кампания не найдена или доступ запрещён', 404);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  // Дефолт — пометить прочитанным; явный { read: false } снимает отметку.
  const read = (body as { read?: unknown }).read !== false;

  try {
    if (read) await recordEmailRead(userId, emailId);
    else await recordEmailUnread(userId, emailId);
    return NextResponse.json({ ok: true, read });
  } catch (err) {
    await logError('client.campaign.replies.read.failed', err, { campaignId, emailId, userId });
    return jsonError('Не удалось обновить статус прочтения', 502);
  }
}

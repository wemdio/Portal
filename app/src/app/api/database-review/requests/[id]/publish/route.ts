import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAuth } from '@/lib/databaseReview/accessGuard';
import { canTransition, type ReviewStatus } from '@/lib/databaseReview/statusTransitions';
import { signCallbackData } from '@/lib/databaseReview/telegramCallback';
import { createGuestToken } from '@/lib/databaseReview/guestToken';
import { logError, logAudit } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

const TG_TOKEN = process.env.AI_CALLER_TG_BOT_TOKEN ?? '';
const GUEST_TOKEN_SECRET = process.env.GUEST_TOKEN_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || 'fallback-secret';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** POST: send approved base to Telegram with approval buttons */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;

  if (!TG_TOKEN) return jsonError('Telegram bot token not configured', 500);

  const { id } = await ctx.params;

  let body: { chatId?: number; message?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError('Invalid JSON', 400);
  }

  if (!body.chatId) return jsonError('chatId is required', 400);

  const { data: reviewReq, error: reqErr } = await auth.supabaseAdmin
    .from('database_review_requests')
    .select('status, tab_name, project_id, owner_user_id')
    .eq('id', id)
    .single();

  if (reqErr || !reviewReq) return jsonError('Request not found', 404);

  const currentStatus = reviewReq.status as ReviewStatus;
  if (!canTransition(currentStatus, 'sent_to_client')) {
    return jsonError(`Cannot publish from status ${currentStatus}`, 400);
  }

  const { token: guestToken, hash: guestHash, expiresAt } = createGuestToken(id, GUEST_TOKEN_SECRET);

  const origin = req.headers.get('origin') || req.headers.get('referer')?.replace(/\/[^/]*$/, '') || '';
  const guestUrl = `${origin}/review/base/${encodeURIComponent(guestToken)}`;

  const lines: string[] = [];
  lines.push('📊 <b>База на согласование</b>');
  lines.push('');
  if (reviewReq.tab_name) lines.push(`📋 <b>Вкладка:</b> ${esc(reviewReq.tab_name)}`);
  if (body.message) {
    lines.push('');
    lines.push(esc(body.message));
  }
  lines.push('');
  lines.push(`🔗 <a href="${esc(guestUrl)}">Просмотреть базу</a>`);

  const callbackSecret = GUEST_TOKEN_SECRET;
  const approveData = signCallbackData(id, 'approve', callbackSecret);
  const changesData = signCallbackData(id, 'request_changes', callbackSecret);

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: body.chatId,
        text: lines.join('\n'),
        parse_mode: 'HTML',
        disable_web_page_preview: false,
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Согласовано', callback_data: approveData },
              { text: '✏️ Пожелания правок', callback_data: changesData },
            ],
          ],
        },
      }),
    });

    const tgData = await tgRes.json();
    if (!tgData.ok) {
      return jsonError(tgData.description || 'Telegram send failed', 502);
    }

    await auth.supabaseAdmin
      .from('database_review_requests')
      .update({
        status: 'sent_to_client',
        telegram_chat_id: body.chatId,
        telegram_message_id: tgData.result?.message_id ?? null,
        telegram_extra_message: body.message || '',
        guest_token_hash: guestHash,
        guest_token_expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);

    await logAudit('database-review.publish.success', 'Sent to Telegram', {
      requestId: id,
      chatId: body.chatId,
    });

    return NextResponse.json({
      ok: true,
      messageId: tgData.result?.message_id,
      guestUrl,
    });
  } catch (err) {
    await logError('database-review.publish.failed', err, { requestId: id });
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return jsonError(msg, 502);
  }
}

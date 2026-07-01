import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { verifyCallbackData } from '@/lib/databaseReview/telegramCallback';
import { createGuestToken } from '@/lib/databaseReview/guestToken';
import { canTransition, type ReviewStatus } from '@/lib/databaseReview/statusTransitions';
import { logError, logAudit } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

const TG_TOKEN = process.env.AI_CALLER_TG_BOT_TOKEN ?? '';
const CALLBACK_SECRET = process.env.GUEST_TOKEN_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || 'fallback-secret';

async function answerCallbackQuery(callbackQueryId: string, text: string) {
  if (!TG_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  }).catch(() => {});
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function handleCallbackQuery(update: Record<string, unknown>) {
  const cq = update.callback_query as Record<string, unknown> | undefined;
  if (!cq?.data || !cq?.id) return;

  const data = cq.data as string;
  const cqId = cq.id as string;

  const verified = verifyCallbackData(data, CALLBACK_SECRET);
  if (!verified.ok) {
    await answerCallbackQuery(cqId, verified.error);
    return;
  }

  const { rid, act } = verified.payload;
  if (!supabaseAdmin) {
    await answerCallbackQuery(cqId, 'Server error');
    return;
  }

  const { data: reviewReq, error: fetchErr } = await supabaseAdmin
    .from('database_review_requests')
    .select('status, guest_token_hash, guest_token_expires_at')
    .eq('id', rid)
    .single();

  if (fetchErr || !reviewReq) {
    await answerCallbackQuery(cqId, 'Заявка не найдена');
    return;
  }

  const currentStatus = reviewReq.status as ReviewStatus;
  const targetStatus: ReviewStatus = act === 'approve' ? 'client_approved' : 'client_requested_changes';

  if (!canTransition(currentStatus, targetStatus)) {
    const statusLabels: Record<string, string> = {
      client_approved: 'Уже согласовано',
      client_requested_changes: 'Правки уже запрошены',
    };
    await answerCallbackQuery(cqId, statusLabels[currentStatus] || `Статус: ${currentStatus}`);
    return;
  }

  const updatePayload: Record<string, unknown> = {
    status: targetStatus,
    updated_at: new Date().toISOString(),
  };

  if (act === 'request_changes') {
    const { token: guestToken, hash, expiresAt } = createGuestToken(rid, CALLBACK_SECRET);
    updatePayload.guest_token_hash = hash;
    updatePayload.guest_token_expires_at = expiresAt;

    const message = cq.message as Record<string, unknown> | undefined;
    const chatId = (message?.chat as Record<string, unknown>)?.id;

    if (chatId && TG_TOKEN) {
      // Self-hosted (nginx/Cloudflare), no VERCEL_URL. Prod sets PORTAL_PUBLIC_URL;
      // NEXT_PUBLIC_SITE_URL is a build-time fallback. (The old expression had an
      // operator-precedence bug: `A || B ? https://B : ''` never used A and B was
      // always empty here, so the link came out relative = dead in Telegram.)
      const origin = (process.env.PORTAL_PUBLIC_URL || process.env.NEXT_PUBLIC_SITE_URL || '')
        .replace(/\/+$/, '');
      const guestUrl = `${origin}/review/base/${encodeURIComponent(guestToken)}`;

      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `✏️ <b>Запрошены правки</b>\n\n🔗 <a href="${esc(guestUrl)}">Оставить комментарии к базе</a>`,
          parse_mode: 'HTML',
          disable_web_page_preview: false,
        }),
      }).catch(() => {});
    }
  }

  await supabaseAdmin
    .from('database_review_requests')
    .update(updatePayload)
    .eq('id', rid);

  const label = act === 'approve' ? '✅ Согласовано!' : '✏️ Запрос правок отправлен';
  await answerCallbackQuery(cqId, label);

  await logAudit('database-review.telegram-callback', `Client action: ${act}`, { requestId: rid, action: act });
}

async function handleChatDiscovery(update: Record<string, unknown>) {
  if (!supabaseAdmin) return;

  const chatMember = update.my_chat_member as Record<string, unknown> | undefined;
  if (chatMember?.chat) {
    const chat = chatMember.chat as Record<string, unknown>;
    const status = (chatMember.new_chat_member as Record<string, unknown>)?.status as string;
    const kicked = ['kicked', 'left'].includes(status);
    if (chat.id && !kicked) {
      await supabaseAdmin.from('ai_caller_tg_chats').upsert({
        chat_id: chat.id,
        title: (chat.title as string) || `Chat ${chat.id}`,
        type: (chat.type as string) || 'group',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'chat_id' });
    } else if (chat.id && kicked) {
      await supabaseAdmin.from('ai_caller_tg_chats').delete().eq('chat_id', chat.id);
    }
  }

  const msg = update.message as Record<string, unknown> | undefined;
  if (msg?.chat) {
    const chat = msg.chat as Record<string, unknown>;
    if (chat.id) {
      await supabaseAdmin.from('ai_caller_tg_chats').upsert({
        chat_id: chat.id,
        title: (chat.title as string) || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || `Chat ${chat.id}`,
        type: (chat.type as string) || 'unknown',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'chat_id' });
    }
  }
}

/** POST: Telegram webhook endpoint */
export async function POST(req: NextRequest) {
  let update: Record<string, unknown>;
  try {
    update = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }

  try {
    if (update.callback_query) {
      await handleCallbackQuery(update);
    }
    await handleChatDiscovery(update);
  } catch (err) {
    await logError('telegram.webhook.error', err);
  }

  return NextResponse.json({ ok: true });
}

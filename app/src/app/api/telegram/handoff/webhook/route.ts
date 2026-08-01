import { NextRequest, NextResponse } from 'next/server';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { verifyHandoffCallback } from '@/lib/instantly/handoffCallback';
import { handoffBotToken, answerCallback, editHandoffMessage } from '@/lib/instantly/handoffTelegram';
import { sendHandoffNow, type PendingHandoffRow } from '@/lib/instantly/handoffSender';

export const dynamic = 'force-dynamic';

const OK = () => NextResponse.json({ ok: true });

interface TgUpdate {
  callback_query?: {
    id: string;
    data?: string;
    from?: { id?: number };
    message?: { message_id?: number; chat?: { id?: number } };
  };
}

/**
 * Webhook for the LEAD_ALERTS bot — handles "Передать клиенту" button presses.
 * Security: the endpoint is public, so we verify Telegram's secret_token header
 * (set via setWebhook) — without it, anyone could POST a forged press carrying
 * the responsible specialist's from.id. Fail-closed if the secret isn't configured.
 * Only the responsible specialist (telegram_id) may trigger the send. Idempotent
 * via the pending row's status. Сама отправка — lib/instantly/handoffSender
 * (общая с авто-режимом воркера при projects.handoff_auto_send=ON).
 */
export async function POST(req: NextRequest) {
  const token = handoffBotToken();
  if (!token) return OK();

  const expectedSecret = process.env.LEAD_HANDOFF_WEBHOOK_SECRET ?? '';
  if (!expectedSecret || req.headers.get('x-telegram-bot-api-secret-token') !== expectedSecret) {
    return OK(); // reject silently — looks like a normal 200 to a forger
  }

  let update: TgUpdate;
  try {
    update = (await req.json()) as TgUpdate;
  } catch {
    return OK();
  }

  const cq = update.callback_query;
  if (!cq?.id) return OK();

  const fromId = cq.from?.id;
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;

  const verify = verifyHandoffCallback(cq.data ?? '', token);
  if (!verify.ok) {
    await answerCallback(token, cq.id, 'Некорректная кнопка');
    return OK();
  }
  const qualificationId = verify.qualificationId;

  if (!supabaseInstantly) {
    await answerCallback(token, cq.id, 'Сервис недоступен');
    return OK();
  }
  const instDb = supabaseInstantly;

  const { data: pending } = await instDb
    .from('instantly_pending_handoffs')
    .select('*')
    .eq('qualification_id', qualificationId)
    .maybeSingle();

  if (!pending) {
    await answerCallback(token, cq.id, 'Передача не найдена');
    return OK();
  }
  if (pending.status !== 'pending') {
    await answerCallback(token, cq.id, pending.status === 'sent' ? 'Уже передано' : 'Недоступно');
    return OK();
  }

  // Only the responsible specialist may press.
  let allowed = false;
  if (pending.responsible_user_id && supabaseAdmin && fromId != null) {
    const { data: link } = await supabaseAdmin
      .from('telegram_links')
      .select('telegram_id')
      .eq('user_id', pending.responsible_user_id)
      .maybeSingle();
    if (link?.telegram_id != null && String(link.telegram_id) === String(fromId)) {
      allowed = true;
    }
  }
  if (!allowed) {
    await answerCallback(token, cq.id, 'Передать может только ответственный за проект специалист', true);
    return OK();
  }

  const result = await sendHandoffNow(instDb, pending as PendingHandoffRow, {
    sentByTelegramId: fromId ?? null,
  });
  if (!result.ok) {
    await answerCallback(token, cq.id, 'Ошибка отправки письма');
    return OK();
  }

  // Consume the button.
  if (chatId != null && messageId != null) {
    await editHandoffMessage(
      token,
      chatId,
      messageId,
      `✅ <b>Передано клиенту</b> — ${pending.client_email}\n(лиду ушёл ответ, клиент в копии${result.replyAllCc.length ? ` + участники переписки: ${result.replyAllCc.join(', ')}` : ''}${result.via === 'test' ? '; отдельным письмом — Others-адресат вне кампании, треда в Unibox не будет' : ''})`,
    );
  }
  await answerCallback(token, cq.id, 'Передано клиенту ✅');
  return OK();
}

import { NextRequest, NextResponse } from 'next/server';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { verifyHandoffCallback, verifyHandoffRejection } from '@/lib/instantly/handoffCallback';
import { handoffBotToken, answerCallback, editHandoffMessage } from '@/lib/instantly/handoffTelegram';
import { sendHandoffNow, type PendingHandoffRow } from '@/lib/instantly/handoffSender';
import { handleHandoffEditor, type HandoffEditUpdate } from '@/lib/instantly/handoffEditor';
import { canActOnManualHandoff } from '@/lib/instantly/handoffAuthorization';
import { rejectManualHandoff } from '@/lib/instantly/handoffRejection';

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
 * Webhook for LEAD_ALERTS — signed handoff buttons and authenticated edit replies.
 * Security: the endpoint is public, so we verify Telegram's secret_token header
 * (set via setWebhook) — without it, anyone could POST a forged press carrying
 * the responsible specialist's from.id. Fail-closed if the secret isn't configured.
 * Only the responsible specialist or opted-in project lead may trigger the send. Idempotent
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

  let update: TgUpdate & HandoffEditUpdate;
  try {
    update = (await req.json()) as TgUpdate & HandoffEditUpdate;
  } catch {
    return OK();
  }

  if (await handleHandoffEditor(update, token)) return OK();
  const cq = update.callback_query;
  if (!cq?.id) return OK();

  const fromId = cq.from?.id;
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;

  const verify = verifyHandoffCallback(cq.data ?? '', token);
  const rejectionId = verifyHandoffRejection(cq.data ?? '', token);
  if (!verify.ok && !rejectionId) {
    await answerCallback(token, cq.id, 'Некорректная кнопка');
    return OK();
  }
  const qualificationId = rejectionId ?? (verify.ok ? verify.qualificationId : '');

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
  if (rejectionId) {
    const result = supabaseAdmin
      ? await rejectManualHandoff(supabaseAdmin, instDb, pending as PendingHandoffRow, { telegramId: fromId, chatId })
      : { ok: false as const, error: 'Сервис недоступен' };
    if (result.ok && chatId != null && messageId != null) {
      await editHandoffMessage(token, chatId, messageId,
        '🚫 <b>Не лид</b> — отмечено специалистом.\nЗапись скрыта из клиентской таблицы. Письмо не отправлено. Решение и исходная переписка сохранены для разбора.');
    }
    await answerCallback(token, cq.id, result.ok ? 'Сохранено: не лид' : result.error, !result.ok);
    return OK();
  }
  if (pending.status !== 'pending') {
    await answerCallback(token, cq.id, pending.status === 'sent' ? 'Уже передано' : pending.status === 'rejected' ? 'Отмечено «Не лид»' : 'Недоступно');
    return OK();
  }

  // One shared access check for the button and the editor/confirmed preview.
  const allowed = supabaseAdmin && chatId != null && pending.tg_chat_id != null &&
    String(pending.tg_chat_id) === String(chatId) &&
    await canActOnManualHandoff(supabaseAdmin, instDb, pending as PendingHandoffRow, fromId);
  if (!allowed) {
    await answerCallback(token, cq.id, 'Передать может только ответственный специалист или лид проекта с разрешением', true);
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

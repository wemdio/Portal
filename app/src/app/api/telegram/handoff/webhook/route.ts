import { NextRequest, NextResponse } from 'next/server';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import * as instantly from '@/lib/instantly/client';
import { verifyHandoffCallback } from '@/lib/instantly/handoffCallback';
import { handoffBotToken, answerCallback, editHandoffMessage } from '@/lib/instantly/handoffTelegram';
import { computeReplyAllCc, mergeCcLists } from '@/lib/clientCampaignReplies/participants';
import { logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

const OK = () => NextResponse.json({ ok: true });

function buildReplySubject(subject?: string | null): string {
  const t = subject?.trim();
  if (!t) return 'Re:';
  return /^re:/i.test(t) ? t : `Re: ${t}`;
}

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
 * via the pending row's status.
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

  const { data: qual } = await instDb
    .from('instantly_lead_qualifications')
    .select('reply_subject, lead_email, lead_name, company_name, campaign_name, reply_body, last_outbound_preview, reply_timestamp, ai_reason')
    .eq('id', qualificationId)
    .maybeSingle();

  // «Ответить всем»: к адресу клиента (handoff CC) добавляем участников, которых
  // лид завёл в тред (То+CC оригинала, кроме нашего ящика и самого лида), иначе
  // молча теряем подключённого лидом ЛПР/коллегу (как в инциденте 30.06). Хандофф —
  // только «под ключ» = main-аккаунт, поэтому accountId не нужен (дефолт = main).
  // getEmail best-effort: не достали оригинал → шлём как раньше, только клиенту.
  let replyAllCc: string[] = [];
  try {
    const original = await instantly.getEmail(pending.reply_to_uuid as string);
    replyAllCc = computeReplyAllCc(original, {
      eaccount: pending.eaccount as string,
      leadEmail: (qual?.lead_email as string | null) ?? null,
    });
  } catch (err) {
    await logError('instantly.handoff.replyall_fetch_failed', err, {
      pendingId: pending.id,
      reply_to_uuid: pending.reply_to_uuid,
    });
  }
  const ccList = mergeCcLists(replyAllCc, ((pending.client_email as string) ?? '').split(','));

  // История переписки в теле: клиент в копии — НОВЫЙ в треде, ему доходит только
  // это письмо, поэтому предыдущий диалог (ответ лида + процитированный им наш
  // оффер, хранится в reply_body) цитируем прямо в тело — иначе клиент видит
  // строку передачи без контекста.
  const draftText = pending.draft_text as string;
  const history = ((qual?.reply_body as string | null) ?? '').trim();
  let bodyText = draftText;
  if (history) {
    const who = (qual?.lead_name as string | null) || (qual?.lead_email as string | null) || 'Лид';
    const when = qual?.reply_timestamp
      ? new Date(qual.reply_timestamp as string).toLocaleString('ru-RU')
      : '';
    const header = [when, who].filter(Boolean).join(', ');
    const quoted = history.split('\n').map((l) => `> ${l}`).join('\n');
    bodyText = `${draftText}\n\n${header ? `${header} писал(а):\n` : ''}${quoted}`;
  }

  // Send: reply into the lead's thread with the client + thread participants in CC.
  try {
    await instantly.replyToEmail({
      reply_to_uuid: pending.reply_to_uuid as string,
      eaccount: pending.eaccount as string,
      subject: buildReplySubject((qual?.reply_subject as string | null) ?? null),
      body: { text: bodyText },
      ...(ccList.length ? { cc_address_email_list: ccList.join(', ') } : {}),
    });
  } catch (err) {
    await instDb
      .from('instantly_pending_handoffs')
      .update({ status: 'failed', error_message: String(err).slice(0, 300) })
      .eq('id', pending.id);
    await answerCallback(token, cq.id, 'Ошибка отправки письма');
    return OK();
  }

  await instDb
    .from('instantly_pending_handoffs')
    .update({ status: 'sent', sent_by_telegram_id: fromId, sent_at: new Date().toISOString() })
    .eq('id', pending.id);

  // Best-effort tracking (mirrors the manual forward-email flow).
  try {
    await instDb.from('client_forwarded_leads').insert({
      qualification_id: qualificationId,
      forwarded_by: pending.responsible_user_id,
      campaign_id: pending.campaign_id,
      campaign_name: qual?.campaign_name ?? null,
      lead_email: qual?.lead_email ?? null,
      lead_name: qual?.lead_name ?? null,
      company_name: qual?.company_name ?? null,
      reply_subject: qual?.reply_subject ?? null,
      reply_body: qual?.reply_body ?? null,
      last_outbound_preview: qual?.last_outbound_preview ?? null,
      reply_timestamp: qual?.reply_timestamp ?? null,
      status: 'lead',
      ai_reason: qual?.ai_reason ?? null,
      forwarded_via: 'handoff-auto',
      client_email: pending.client_email,
    });
  } catch {
    /* tracking is best-effort */
  }

  // Consume the button.
  if (chatId != null && messageId != null) {
    await editHandoffMessage(
      token,
      chatId,
      messageId,
      `✅ <b>Передано клиенту</b> — ${pending.client_email}\n(лиду ушёл ответ, клиент в копии${replyAllCc.length ? ` + участники переписки: ${replyAllCc.join(', ')}` : ''})`,
    );
  }
  await answerCallback(token, cq.id, 'Передано клиенту ✅');
  return OK();
}

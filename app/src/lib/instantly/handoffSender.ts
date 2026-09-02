import type { supabaseInstantly } from '@/lib/supabaseInstantly';
import * as instantly from './client';
import { computeReplyAllCc, mergeCcLists } from '@/lib/clientCampaignReplies/participants';
import { isNotPartOfCampaignError } from '@/lib/instantly/notPartOfCampaign';
import { textToReplyHtml } from '@/lib/clientCampaignReplies/bodyHtml';
import { logError } from '@/lib/loggerServer';

/**
 * Общая отправка передачи лида клиенту: и TG-кнопка (webhook), и полный авто
 * (worker при projects.handoff_auto_send=ON). Reply в тред лида + клиент в CC;
 * для Others-письма (вне кампании) — fallback на test-email (лид+клиент в To).
 * Трекинг в client_forwarded_leads, статус pending → sent/failed.
 */

type InstantlyDb = NonNullable<typeof supabaseInstantly>;

// Rollout marker for rows created while the durable `auto_send` snapshot
// column is not available yet. It survives a failed send and lets recovery
// distinguish an automatic handoff from an old manual pending row after the
// migration backfills `auto_send=false`.
export const HANDOFF_AUTO_SEND_MARKER = '[auto_send]';

export interface PendingHandoffRow {
  id: string;
  qualification_id: string;
  campaign_id: string | null;
  draft_text: string;
  reply_to_uuid: string;
  eaccount: string;
  client_email: string;
  responsible_user_id: string | null;
  auto_send?: boolean;
  error_message?: string | null;
}

export type HandoffSendResult =
  | { ok: true; via: 'reply' | 'test'; replyAllCc: string[] }
  | { ok: false; error: string };

function buildReplySubject(subject?: string | null): string {
  const t = subject?.trim();
  if (!t) return 'Re:';
  return /^re:/i.test(t) ? t : `Re: ${t}`;
}

export async function sendHandoffNow(
  db: InstantlyDb,
  pending: PendingHandoffRow,
  opts: { sentByTelegramId?: number | null } = {},
): Promise<HandoffSendResult> {
  const { data: qual } = await db
    .from('instantly_lead_qualifications')
    .select('reply_subject, lead_email, lead_name, company_name, campaign_name, reply_body, last_outbound_preview, reply_timestamp, ai_reason')
    .eq('id', pending.qualification_id)
    .maybeSingle();

  // «Ответить всем»: к адресу клиента (handoff CC) добавляем участников, которых
  // лид завёл в тред (То+CC оригинала, кроме нашего ящика и самого лида).
  // getEmail best-effort: не достали оригинал → шлём только клиенту.
  let replyAllCc: string[] = [];
  try {
    const original = await instantly.getEmail(pending.reply_to_uuid);
    replyAllCc = computeReplyAllCc(original, {
      eaccount: pending.eaccount,
      leadEmail: (qual?.lead_email as string | null) ?? null,
    });
  } catch (err) {
    await logError('instantly.handoff.replyall_fetch_failed', err, {
      pendingId: pending.id,
      reply_to_uuid: pending.reply_to_uuid,
    });
  }
  const ccList = mergeCcLists(replyAllCc, (pending.client_email ?? '').split(','));

  // История переписки в теле: клиент в копии — НОВЫЙ в треде, ему доходит только
  // это письмо, поэтому предыдущий диалог цитируем прямо в тело.
  const draftText = pending.draft_text;
  const history = ((qual?.reply_body as string | null) ?? '').trim();
  let bodyText = draftText;
  if (history) {
    const who = (qual?.lead_name as string | null) || (qual?.lead_email as string | null) || 'Лид';
    // Контейнер в UTC — без явной таймзоны в шапке цитаты было бы «14:01»
    // вместо «17:01», которые лид видел у себя в письме.
    const when = qual?.reply_timestamp
      ? new Date(qual.reply_timestamp as string).toLocaleString('ru-RU', {
          timeZone: 'Europe/Moscow',
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '';
    const header = [when, who].filter(Boolean).join(', ');
    const quoted = history.split('\n').map((l) => `> ${l}`).join('\n');
    bodyText = `${draftText}\n\n${header ? `${header} писал(а):\n` : ''}${quoted}`;
  }

  // Reply в тред; Others-письма не принадлежат кампании — Instantly отвечает 400
  // «not part of an Instantly campaign» и на reply, и на forward (проверено
  // живьём 27.07), для них fallback — тест-эндпоинт (лид и клиент в To,
  // видимость адресов та же, что у cc). Плата: без сущности в Unibox.
  let via: 'reply' | 'test' = 'reply';
  try {
    const replySubject = buildReplySubject((qual?.reply_subject as string | null) ?? null);
    const replyHtml = textToReplyHtml(bodyText);
    try {
      await instantly.replyToEmail({
        reply_to_uuid: pending.reply_to_uuid,
        eaccount: pending.eaccount,
        subject: replySubject,
        // HTML с <br> сохраняет переносы строк (text-only с \n схлопывается
        // «простынёй» — жалоба спеца на Чизмоле). text — plain-text fallback.
        body: { html: replyHtml, text: bodyText },
        ...(ccList.length ? { cc_address_email_list: ccList.join(', ') } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const leadEmail = ((qual?.lead_email as string | null) ?? '').trim();
      if (!isNotPartOfCampaignError(msg) || !leadEmail) throw err;
      await instantly.sendTestEmail({
        eaccount: pending.eaccount,
        // Дедуп: при патологическом client_email == lead_email To не дублируется.
        to_address_email_list: [...new Set([leadEmail, ...ccList])].join(', '),
        subject: replySubject,
        body: { html: replyHtml },
      });
      via = 'test';
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const autoSend = pending.auto_send === true ||
      pending.error_message?.startsWith(HANDOFF_AUTO_SEND_MARKER) === true;
    await db
      .from('instantly_pending_handoffs')
      .update({
        status: 'failed',
        error_message: `${autoSend ? `${HANDOFF_AUTO_SEND_MARKER} ` : ''}${message}`.slice(0, 300),
      })
      .eq('id', pending.id);
    return { ok: false, error: message };
  }

  await db
    .from('instantly_pending_handoffs')
    .update({
      status: 'sent',
      error_message: null,
      ...(opts.sentByTelegramId != null ? { sent_by_telegram_id: opts.sentByTelegramId } : {}),
      sent_at: new Date().toISOString(),
    })
    .eq('id', pending.id);

  // Best-effort tracking (mirrors the manual forward-email flow).
  try {
    await db.from('client_forwarded_leads').insert({
      qualification_id: pending.qualification_id,
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
      forwarded_via: via === 'test' ? 'handoff-auto-test' : 'handoff-auto',
      client_email: pending.client_email,
    });
  } catch {
    /* tracking is best-effort */
  }

  return { ok: true, via, replyAllCc };
}

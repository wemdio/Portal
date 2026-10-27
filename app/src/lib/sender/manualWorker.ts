import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { authForMailbox } from './mailboxAuth';
import { sendSenderMail } from './smtp';
import type { MailboxRow } from './types';

/**
 * Отправка ручных ответов оператора (задача 4.1 хендоффа фич).
 *
 * Ответ заводится из окна переписки через API и ложится в очередь; сюда
 * попадает воркером сендера. SMTP обязан ходить только с изолированного
 * sender-хоста — поэтому не из API-процесса, а через БД, как у остальной
 * отправки. Ответ уходит с закреплённого ящика лида (sticky sender) и с
 * In-Reply-To в тот же тред.
 *
 * Той же очередью уходит тестовое письмо себе из формы кампании: произвольное
 * письмо с выбранного ящика, только без переписки — campaign_id и recipient_id
 * у него пустые (миграция 20261001_0020).
 */

type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

const MAX_ATTEMPTS = 3;

interface ManualRow {
  id: string;
  /** null у тестового письма: его шлют себе до того, как кампания создана. */
  campaign_id: string | null;
  recipient_id: string | null;
  mailbox_id: string;
  to_email: string;
  subject: string;
  body: string;
  message_id: string;
  in_reply_to: string | null;
  attempts: number;
  cc_emails?: string[];
  agency_handoff_id?: string | null;
  /** Передача лида клиенту (lib/sender/clientHandoff): клиент в копии, повтора нет. */
  handoff?: Record<string, unknown> | null;
  /** Письмо квалифицирующего ИИ (lib/senderAiQualifier): перепроверка перед SMTP, повтора нет. */
  by_ai?: boolean;
  created_at?: string;
}

function fromHeader(mailbox: MailboxRow): string {
  const name = (mailbox.display_name ?? '').trim();
  return name ? `${name} <${mailbox.email}>` : mailbox.email;
}

/** Один проход дренажа ручных ответов. */
export async function processManualMessages(opts: { egressIp: string; log?: Log; batchSize?: number }): Promise<number> {
  if (!supabaseAdmin) return 0;
  const db = supabaseAdmin;
  const log: Log = opts.log ?? (() => {});

  const { data: claimed, error: claimError } = await db.rpc('claim_sender_manual_messages', {
    p_limit: opts.batchSize ?? 5,
    p_egress_ip: opts.egressIp,
  });
  if (claimError) {
    log('warn', `Ручные ответы не забрались из очереди: ${claimError.message}`);
    return 0;
  }
  const messages = (claimed ?? []) as ManualRow[];
  if (!messages.length) return 0;

  let sent = 0;
  for (const message of messages) {
    const nowIso = new Date().toISOString();
    if (message.agency_handoff_id) {
      // Recheck immediately before SMTP: a queued introduction is cancelled by
      // disabling the setting, opt-out, manual rejection or an operator's reply.
      const [handoff, recipient, manual, suppression] = await Promise.all([
        db.from('agency_lead_handoffs').select('scope, created_at').eq('id', message.agency_handoff_id).maybeSingle(),
        db.from('sender_recipients').select('status, lead_verdict, lead_verdict_source').eq('id', message.recipient_id!).maybeSingle(),
        db.from('sender_manual_messages').select('id').eq('recipient_id', message.recipient_id!)
          .is('agency_handoff_id', null).limit(1),
        db.from('sender_suppressions').select('email').eq('email', message.to_email).limit(1),
      ]);
      const config = handoff.data ? await db.from('agency_lead_handoff_settings').select('enabled, enabled_at')
        .eq('scope', handoff.data.scope).maybeSingle() : null;
      const r = recipient.data;
      const blocked = handoff.error || recipient.error || manual.error || suppression.error || config?.error ||
        !config?.data?.enabled || !config.data.enabled_at || !handoff.data || handoff.data.created_at < config.data.enabled_at ||
        !r || ['unsubscribed', 'bounced', 'stopped'].includes(r.status) ||
        (r.lead_verdict_source === 'manual' && r.lead_verdict === 'not_lead') || manual.data?.length || suppression.data?.length;
      if (blocked) {
        await db.from('sender_manual_messages').update({ status: 'failed',
          error: 'Автопередача отменена: проверьте настройки, состояние переписки и ручные ответы', updated_at: nowIso }).eq('id', message.id);
        continue;
      }
    }
    if (message.by_ai) {
      // Пока письмо ИИ ждало отправки, лид мог отписаться, оператор — ответить
      // или поставить метку: тогда ИИ молчит.
      const [recipient, conversation, operator, suppression] = await Promise.all([
        db.from('sender_recipients').select('status, lead_verdict_source').eq('id', message.recipient_id!).maybeSingle(),
        db.from('sender_ai_conversations').select('state').eq('recipient_id', message.recipient_id!).maybeSingle(),
        db.from('sender_manual_messages').select('id').eq('recipient_id', message.recipient_id!)
          .is('agency_handoff_id', null).is('handoff', null).eq('by_ai', false).limit(1),
        db.from('sender_suppressions').select('email').eq('email', message.to_email).limit(1),
      ]);
      const r = recipient.data;
      const blocked = recipient.error || conversation.error || operator.error || suppression.error || !r ||
        ['unsubscribed', 'bounced', 'stopped'].includes(r.status) || r.lead_verdict_source === 'manual' ||
        conversation.data?.state === 'stopped' || operator.data?.length || suppression.data?.length;
      if (blocked) {
        await db.from('sender_manual_messages').update({ status: 'failed',
          error: 'Письмо ИИ отменено: переписка остановлена, отписка, ручная метка или ответ оператора', updated_at: nowIso }).eq('id', message.id);
        continue;
      }
    }
    if (message.handoff) {
      // Между передачей и отправкой адрес могли закрыть: отписка, отбой, стоп-лист.
      const [recipient, globalStop, campaignStop] = await Promise.all([
        db.from('sender_recipients').select('status').eq('id', message.recipient_id!).maybeSingle(),
        db.from('sender_suppressions').select('email').eq('email', message.to_email).limit(1),
        db.from('sender_campaign_suppressions').select('email')
          .eq('campaign_id', message.campaign_id!).eq('email', message.to_email).neq('reason', 'mailbox_lost').limit(1),
      ]);
      const closed = recipient.error || globalStop.error || campaignStop.error || !recipient.data ||
        ['unsubscribed', 'bounced'].includes(String(recipient.data.status)) ||
        globalStop.data?.length || campaignStop.data?.length;
      if (closed) {
        await db.from('sender_manual_messages').update({ status: 'failed',
          error: 'Передача отменена: адрес отписался, в отбое или в стоп-листе', updated_at: nowIso }).eq('id', message.id);
        continue;
      }
    }
    const { data: row } = await db.from('sender_mailboxes').select('*').eq('id', message.mailbox_id).maybeSingle();
    const mailbox = row as MailboxRow | null;

    if (mailbox && mailbox.egress_ip !== opts.egressIp) {
      // Ящик перенесли между claim и отправкой — ответ уйдёт с нового адреса.
      await db.from('sender_manual_messages').update({ status: 'queued', updated_at: nowIso }).eq('id', message.id);
      continue;
    }

    if (!mailbox || mailbox.status !== 'verified' || !mailbox.enabled) {
      await db.from('sender_manual_messages')
        .update({ status: 'failed', error: 'Ящик недоступен — ответьте после починки ящика', updated_at: nowIso })
        .eq('id', message.id);
      continue;
    }

    const auth = await authForMailbox(mailbox);
    if (!auth.ok) {
      await db.from('sender_manual_messages')
        .update({ status: 'failed', error: `Ящик не вошёл: ${auth.error}`, updated_at: nowIso })
        .eq('id', message.id);
      continue;
    }

    const result = await sendSenderMail(
      {
        host: mailbox.smtp_host,
        port: mailbox.smtp_port,
        tlsMode: mailbox.smtp_tls_mode,
        username: mailbox.username,
        auth: auth.smtp,
      },
      {
        from: fromHeader(mailbox),
        to: message.to_email,
        cc: message.cc_emails,
        subject: message.subject,
        text: message.body,
        messageId: message.message_id,
        inReplyTo: message.in_reply_to,
        references: message.in_reply_to,
      },
    );

    const attempts = message.attempts + 1;
    if (result.ok) {
      await db.from('sender_manual_messages')
        .update({ status: 'sent', sent_at: new Date().toISOString(), attempts, error: null, updated_at: nowIso })
        .eq('id', message.id);
      sent += 1;
      continue;
    }

    // Передача принята частично (письмо приняли, адрес в копии отклонён):
    // письмо ушло. Считаем ушедшим с предупреждением в ленте — иначе лид не
    // попал бы в кабинет клиента, а повторная передача прислала бы письмо
    // второй раз.
    if (message.handoff && result.code === 'partial_accept') {
      await db.from('sender_manual_messages')
        .update({ status: 'sent', sent_at: new Date().toISOString(), attempts,
          error: `Ушло не всем: ${result.error ?? 'часть адресов отклонена'}`, updated_at: nowIso })
        .eq('id', message.id);
      sent += 1;
      log('warn', `Передача ${message.to_email} принята частично: ${result.error ?? result.code}`);
      continue;
    }

    // Ручной ответ ретраим мягко: оставляем в 'sending' — stale-ветка claim
    // подберёт его через 10 минут (это и есть задержка ретрая), вечного цикла
    // нет из-за потолка попыток. Обрыв посреди диалога (inflight_drop) и
    // частичный приём (partial_accept): письмо могло уже дойти, повтор
    // прислал бы лиду дубль.
    // Передачу не повторяем сами: оператор видит ошибку и передаёт заново.
    if (!message.agency_handoff_id && !message.handoff && !message.by_ai && attempts < MAX_ATTEMPTS && result.code !== 'recipient_rejected'
      && result.code !== 'rejected' && result.code !== 'inflight_drop' && result.code !== 'partial_accept') {
      await db.from('sender_manual_messages')
        .update({ attempts, error: result.error ?? null })
        .eq('id', message.id);
      continue;
    }

    // Обрыв передачи: исход неизвестен — оператору нужно знать, что письмо могло уйти.
    const failure = message.handoff && result.code === 'inflight_drop'
      ? `Исход неизвестен: соединение оборвалось (${result.error ?? 'обрыв'}). Письмо могло уйти — передавайте заново, только если лид и клиент его не получили`
      : result.error ?? result.code ?? 'send_failed';
    await db.from('sender_manual_messages')
      .update({ status: 'failed', attempts, error: failure, updated_at: nowIso })
      .eq('id', message.id);
    log('warn', `Ручной ответ ${message.to_email} не ушёл (${result.code})`);
  }

  return sent;
}

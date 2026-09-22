import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { authForMailbox } from './mailboxAuth';
import { sendSenderMail, type SendErrorCode } from './smtp';
import type { MailboxRow, MessageRow, RecipientRow, StepRow } from './types';

/**
 * Отправка писем из очереди. Письмо берётся атомарно (claim_sender_messages,
 * FOR UPDATE SKIP LOCKED), поэтому параллельные воркеры — сейчас один сервер,
 * дальше несколько — не отправят одно письмо дважды.
 */

type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 5 * 60 * 1000;
/** Насколько сдвигаем письмо, возвращённое из-за проблем ящика (не письма). */
const MAILBOX_PROBLEM_DELAY_MS = 10 * 60 * 1000;

function fromHeader(mailbox: MailboxRow): string {
  const name = (mailbox.display_name ?? '').trim();
  return name ? `${name} <${mailbox.email}>` : mailbox.email;
}

function backoffMs(attempts: number): number {
  return BACKOFF_BASE_MS * Math.min(attempts, 4) ** 2;
}

/**
 * Куда двигать письмо после неудачи — зависит от типа ошибки, а не от счётчика.
 *
 * unknown-исход («провайдер мог принять письмо») — терминальный: автоматический
 * повтор после обрыва на DATA отправил бы получателю дубль, поэтому такие
 * письма достаются оператору.
 */
function retryPlan(code: SendErrorCode | undefined, attempts: number): 'retry' | 'fail' | 'hold' | 'unknown' {
  switch (code) {
    case 'recipient_rejected':
    case 'rejected':
      return 'fail';
    case 'auth':
    case 'blocked_target':
    case 'policy_reject':
      return 'hold';
    case 'inflight_drop':
      return 'unknown';
    case 'rate_limit':
    case 'temporary':
    case 'network':
    case 'unknown':
    default:
      return attempts >= MAX_ATTEMPTS ? 'fail' : 'retry';
  }
}

async function afterSend(message: MessageRow, mailbox: MailboxRow, sentAt: string): Promise<void> {
  if (!supabaseAdmin) return;
  const db = supabaseAdmin;

  const { data: recipientRow } = await db
    .from('sender_recipients')
    .select('*')
    .eq('id', message.recipient_id)
    .maybeSingle();
  const recipient = recipientRow as RecipientRow | null;
  if (!recipient) return;

  const { data: nextStepRow } = await db
    .from('sender_campaign_steps')
    .select('*')
    .eq('campaign_id', message.campaign_id)
    .eq('step_no', message.step_no + 1)
    .maybeSingle();
  const nextStep = nextStepRow as StepRow | null;

  const patch: Record<string, unknown> = {
    last_step_sent: message.step_no,
    updated_at: sentAt,
  };
  // Message-ID первого письма — корень переписки: follow-up уходят ответом
  // в него, поэтому у получателя это одна ветка, а не отдельные письма.
  if (message.step_no === 1) patch.thread_message_id = message.message_id;

  if (nextStep) {
    const next = new Date(new Date(sentAt).getTime() + nextStep.delay_hours * 60 * 60 * 1000);
    patch.next_step_at = next.toISOString();
  } else {
    patch.status = 'finished';
    patch.next_step_at = null;
  }

  await db.from('sender_recipients').update(patch).eq('id', recipient.id);
  await db.from('sender_mailboxes').update({ last_send_at: sentAt }).eq('id', mailbox.id);
}

/**
 * Один проход отправки. Возвращает true, если что-то отправили — тогда воркер
 * сразу делает следующий проход, не выжидая интервал опроса.
 */
export async function processSenderBatch(opts?: { batchSize?: number; log?: Log }): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const db = supabaseAdmin;
  const log: Log = opts?.log ?? (() => {});
  const batchSize = opts?.batchSize ?? 20;

  const { data: claimed } = await db.rpc('claim_sender_messages', { p_limit: batchSize });
  const messages = (claimed ?? []) as MessageRow[];
  if (!messages.length) return false;

  const mailboxCache = new Map<string, MailboxRow | null>();
  let sentCount = 0;

  for (const message of messages) {
    let mailbox = mailboxCache.get(message.mailbox_id);
    if (mailbox === undefined) {
      const { data } = await db.from('sender_mailboxes').select('*').eq('id', message.mailbox_id).maybeSingle();
      mailbox = (data as MailboxRow | null) ?? null;
      mailboxCache.set(message.mailbox_id, mailbox);
    }

    if (!mailbox || mailbox.status !== 'verified') {
      // Сдвиг обязателен: claim сортирует по scheduled_at, и письмо без сдвига
      // навсегда остаётся самым старым — двадцать таких съедают весь батч, и
      // отправка встаёт в ноль, пока ящик чинят.
      const retryAt = new Date(Date.now() + MAILBOX_PROBLEM_DELAY_MS).toISOString();
      await db
        .from('sender_messages')
        .update({ status: 'scheduled', scheduled_at: retryAt, error: 'Ящик недоступен или не подтверждён' })
        .eq('id', message.id);
      continue;
    }

    // Ящик не пускает — это его проблема, а не письма: письмо возвращаем в
    // очередь и ждём, пока ящик починят, иначе потеряли бы касание по лиду.
    const auth = await authForMailbox(mailbox);
    if (!auth.ok) {
      const retryAt = new Date(Date.now() + MAILBOX_PROBLEM_DELAY_MS).toISOString();
      await db.from('sender_messages').update({ status: 'scheduled', scheduled_at: retryAt, error: auth.error }).eq('id', message.id);
      await db.from('sender_mailboxes').update({ status: 'failed', last_error: auth.error }).eq('id', mailbox.id);
      mailboxCache.set(mailbox.id, { ...mailbox, status: 'failed' });
      continue;
    }

    const attempts = message.attempts + 1;
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
        subject: message.subject,
        text: message.body,
        messageId: message.message_id,
        inReplyTo: message.in_reply_to,
        references: message.in_reply_to,
      },
    );

    if (result.ok) {
      const sentAt = new Date().toISOString();
      // Провайдер письмо принял — дальше любая наша ошибка записи означает риск
      // дубля: lease истечёт, claim отдаст письмо повторно. Проверяем результат
      // и при неудаче фиксируем «unknown», чтобы письмо не вернулось в оборот.
      const { error: markError } = await db
        .from('sender_messages')
        .update({ status: 'sent', sent_at: sentAt, attempts, error: null })
        .eq('id', message.id);
      if (markError) {
        log('error', `Письмо ${message.id} отправлено, но не зафиксировано (${markError.message}) — проверьте вручную`, {
          to: message.to_email,
        });
        await db
          .from('sender_messages')
          .update({ status: 'unknown', attempts, error: 'Отправлено, но не зафиксировано в базе — проверить вручную' })
          .eq('id', message.id);
        continue;
      }
      await afterSend(message, mailbox, sentAt);
      sentCount += 1;
      continue;
    }

    const plan = retryPlan(result.code, attempts);
    log('warn', `Письмо ${message.to_email} не ушло (${result.code}): ${result.error ?? 'нет деталей'}`);

    if (plan === 'unknown') {
      // Провайдер мог принять письмо (обрыв после DATA): повтор отправил бы
      // дубль. Показываем оператору, автоматический ретрай запрещён.
      await db
        .from('sender_messages')
        .update({ status: 'unknown', attempts, error: result.error ?? 'соединение оборвалось при отправке' })
        .eq('id', message.id);
      continue;
    }

    if (plan === 'fail') {
      await db
        .from('sender_messages')
        .update({ status: 'failed', attempts, error: result.error ?? result.code ?? 'send_failed' })
        .eq('id', message.id);

      if (result.code === 'recipient_rejected') {
        // Постоянный отказ по получателю — это отбойник: адрес в стоп-лист,
        // цепочка по нему больше не идёт. Отказ без опознанного «адреса нет»
        // (голый 5xx, спам-блокировки) адрес не выжигает.
        await db.from('sender_recipients').update({ status: 'bounced', next_step_at: null }).eq('id', message.recipient_id);
        await db
          .from('sender_suppressions')
          .upsert(
            { email: message.to_email, reason: 'hard_bounce', note: result.error?.slice(0, 500) ?? null },
            { onConflict: 'email' },
          );
      }
      continue;
    }

    if (plan === 'hold') {
      // Проблема не в письме, а в ящике: выключаем ящик и возвращаем письмо в
      // очередь, чтобы оно ушло после переподключения. Сюда же попадает
      // спам-блокировка провайдера (5.7.x) — вина ящика, а не получателя.
      const retryAt = new Date(Date.now() + MAILBOX_PROBLEM_DELAY_MS).toISOString();
      await db
        .from('sender_messages')
        .update({ status: 'scheduled', scheduled_at: retryAt, attempts, error: result.error ?? null })
        .eq('id', message.id);
      await db
        .from('sender_mailboxes')
        .update({ status: 'failed', last_error: result.error?.slice(0, 500) ?? 'Ящик отклонил вход' })
        .eq('id', mailbox.id);
      mailboxCache.set(mailbox.id, { ...mailbox, status: 'failed' });
      continue;
    }

    const retryAt = new Date(Date.now() + backoffMs(attempts)).toISOString();
    await db
      .from('sender_messages')
      .update({ status: 'scheduled', scheduled_at: retryAt, attempts, error: result.error ?? null })
      .eq('id', message.id);
  }

  return sentCount > 0;
}

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
 */

type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

const MAX_ATTEMPTS = 3;

interface ManualRow {
  id: string;
  campaign_id: string;
  recipient_id: string;
  mailbox_id: string;
  to_email: string;
  subject: string;
  body: string;
  message_id: string;
  in_reply_to: string | null;
  attempts: number;
}

function fromHeader(mailbox: MailboxRow): string {
  const name = (mailbox.display_name ?? '').trim();
  return name ? `${name} <${mailbox.email}>` : mailbox.email;
}

/** Один проход дренажа ручных ответов. */
export async function processManualMessages(opts?: { log?: Log; batchSize?: number }): Promise<number> {
  if (!supabaseAdmin) return 0;
  const db = supabaseAdmin;
  const log: Log = opts?.log ?? (() => {});

  const { data: claimed, error: claimError } = await db.rpc('claim_sender_manual_messages', {
    p_limit: opts?.batchSize ?? 5,
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
    const { data: row } = await db.from('sender_mailboxes').select('*').eq('id', message.mailbox_id).maybeSingle();
    const mailbox = row as MailboxRow | null;

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

    // Ручной ответ ретраим мягко: оставляем в 'sending' — stale-ветка claim
    // подберёт его через 10 минут (это и есть задержка ретрая), вечного цикла
    // нет из-за потолка попыток.
    if (attempts < MAX_ATTEMPTS && result.code !== 'recipient_rejected' && result.code !== 'rejected') {
      await db.from('sender_manual_messages')
        .update({ attempts, error: result.error ?? null })
        .eq('id', message.id);
      continue;
    }

    await db.from('sender_manual_messages')
      .update({ status: 'failed', attempts, error: result.error ?? result.code ?? 'send_failed', updated_at: nowIso })
      .eq('id', message.id);
    log('warn', `Ручной ответ ${message.to_email} не ушёл (${result.code})`);
  }

  return sent;
}

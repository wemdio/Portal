import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { fetchNewReplies, type ReplyMailboxRow } from '@/lib/byoMailbox/imap';
import { classifyReply, extractBouncedRecipient } from './replyClassify';
import type { MailboxRow, ReplyKind } from './types';

/**
 * Опрос входящих по подключённым ящикам: складываем ответы, связываем их с
 * получателями кампаний и обрываем цепочку тем, кто ответил.
 *
 * IMAP-движок переиспользуется из контура byoMailbox (там же SSRF-проверка
 * хоста и курсор по UID), чтобы не держать две реализации чтения почты.
 */

type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

const MAILBOXES_PER_PASS = 30;

function toImapRow(mailbox: MailboxRow): ReplyMailboxRow {
  return {
    id: mailbox.id,
    // Ящики инструмента не принадлежат клиенту портала — поле нужно только
    // сигнатуре общего IMAP-модуля.
    client_user_id: '',
    email: mailbox.email,
    username: mailbox.username,
    secret_encrypted: mailbox.secret_encrypted,
    auth_type: 'password',
    imap_host: mailbox.imap_host,
    imap_port: mailbox.imap_port,
    imap_last_uid: mailbox.imap_last_uid,
    imap_uidvalidity: mailbox.imap_uidvalidity,
  };
}

/** Кампании, которые ведутся с этого ящика: в них ищем автора ответа. */
async function campaignIdsOfMailbox(mailboxId: string): Promise<string[]> {
  if (!supabaseAdmin) return [];
  const { data } = await supabaseAdmin
    .from('sender_campaign_mailboxes')
    .select('campaign_id')
    .eq('mailbox_id', mailboxId);
  return (data ?? []).map((row) => String(row.campaign_id));
}

async function findRecipientByThread(inReplyTo: string | null): Promise<string | null> {
  if (!supabaseAdmin || !inReplyTo) return null;
  const { data } = await supabaseAdmin
    .from('sender_messages')
    .select('recipient_id')
    .eq('message_id', inReplyTo)
    .maybeSingle();
  return data ? String(data.recipient_id) : null;
}

async function findRecipientByEmail(email: string | null, campaignIds: string[]): Promise<string | null> {
  if (!supabaseAdmin || !email || !campaignIds.length) return null;
  const { data } = await supabaseAdmin
    .from('sender_recipients')
    .select('id')
    .in('campaign_id', campaignIds)
    .eq('email', email.toLowerCase())
    .limit(1)
    .maybeSingle();
  return data ? String(data.id) : null;
}

/** Отменяет ещё не отправленные письма лида: после ответа дожимать нельзя. */
async function cancelPendingMessages(recipientId: string): Promise<void> {
  if (!supabaseAdmin) return;
  await supabaseAdmin
    .from('sender_messages')
    .update({ status: 'canceled' })
    .eq('recipient_id', recipientId)
    .in('status', ['scheduled', 'sending']);
}

async function applyReply(params: {
  kind: ReplyKind;
  recipientId: string | null;
  bouncedEmail: string | null;
  campaignIds: string[];
  log: Log;
}): Promise<void> {
  if (!supabaseAdmin) return;
  const db = supabaseAdmin;
  const nowIso = new Date().toISOString();

  if (params.kind === 'human' && params.recipientId) {
    await db
      .from('sender_recipients')
      .update({ status: 'replied', replied_at: nowIso, next_step_at: null, updated_at: nowIso })
      .eq('id', params.recipientId);
    await cancelPendingMessages(params.recipientId);
    return;
  }

  if (params.kind === 'bounce') {
    const email = params.bouncedEmail;
    if (email) {
      await db
        .from('sender_suppressions')
        .upsert({ email, reason: 'hard_bounce', note: 'отбойник из входящего письма' }, { onConflict: 'email' });
    }
    const recipientId = params.recipientId ?? (await findRecipientByEmail(email, params.campaignIds));
    if (recipientId) {
      await db
        .from('sender_recipients')
        .update({ status: 'bounced', next_step_at: null, updated_at: nowIso })
        .eq('id', recipientId);
      await cancelPendingMessages(recipientId);
    }
  }
}

/** Один проход опроса входящих. true — если что-то новое нашли. */
export async function processSenderReplies(opts?: { log?: Log }): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const db = supabaseAdmin;
  const log: Log = opts?.log ?? (() => {});

  const { data: mailboxRows } = await db
    .from('sender_mailboxes')
    .select('*')
    .eq('status', 'verified')
    .not('imap_host', 'is', null)
    .order('imap_checked_at', { ascending: true, nullsFirst: true })
    .limit(MAILBOXES_PER_PASS);

  const mailboxes = (mailboxRows ?? []) as MailboxRow[];
  if (!mailboxes.length) return false;

  let found = false;

  for (const mailbox of mailboxes) {
    const nowIso = new Date().toISOString();
    try {
      const result = await fetchNewReplies(toImapRow(mailbox));
      if (!result) {
        await db.from('sender_mailboxes').update({ imap_checked_at: nowIso }).eq('id', mailbox.id);
        continue;
      }

      if (result.replies.length) {
        const campaignIds = await campaignIdsOfMailbox(mailbox.id);

        for (const reply of result.replies) {
          const kind = classifyReply({
            fromEmail: reply.fromEmail,
            subject: reply.subject,
            body: reply.body,
          });
          const bouncedEmail = kind === 'bounce' ? extractBouncedRecipient(reply.body, mailbox.email) : null;
          const recipientId =
            (await findRecipientByThread(reply.inReplyTo)) ??
            (kind === 'bounce'
              ? await findRecipientByEmail(bouncedEmail, campaignIds)
              : await findRecipientByEmail(reply.fromEmail, campaignIds));

          await db.from('sender_replies').upsert(
            {
              mailbox_id: mailbox.id,
              uid: reply.uid,
              from_email: reply.fromEmail ? reply.fromEmail.toLowerCase() : null,
              from_name: reply.fromName,
              subject: reply.subject,
              body: reply.body,
              message_id: reply.messageId,
              in_reply_to: reply.inReplyTo,
              kind,
              recipient_id: recipientId,
              received_at: reply.receivedAt,
            },
            { onConflict: 'mailbox_id,uid', ignoreDuplicates: true },
          );

          await applyReply({ kind, recipientId, bouncedEmail, campaignIds, log });
        }

        found = true;
        log('info', `Ящик ${mailbox.email}: новых входящих ${result.replies.length}`);
      }

      await db
        .from('sender_mailboxes')
        .update({
          imap_last_uid: result.newLastUid,
          imap_uidvalidity: result.uidValidity,
          imap_checked_at: nowIso,
        })
        .eq('id', mailbox.id);
    } catch (e) {
      log('warn', `Не удалось прочитать входящие ${mailbox.email}: ${e instanceof Error ? e.message : String(e)}`);
      await db
        .from('sender_mailboxes')
        .update({ imap_checked_at: nowIso, last_error: e instanceof Error ? e.message.slice(0, 500) : null })
        .eq('id', mailbox.id);
    }
  }

  return found;
}

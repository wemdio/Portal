import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { fetchNewReplies, type ReplyMailboxRow } from './imap';

/**
 * Один проход опроса IMAP: для каждого подтверждённого ящика забирает новые письма,
 * складывает в client_byo_replies (дедуп по mailbox_id+uid), сопоставляет отправителя
 * с лидом, которому мы писали, и двигает IMAP-курсор. Возвращает true, если что-то нашли.
 */

type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

const COLS =
  'id, client_user_id, email, username, secret_encrypted, auth_type, imap_host, imap_port, imap_last_uid, imap_uidvalidity, status';

export async function processByoRepliesBatch(opts?: { maxMailboxes?: number; log?: Log }): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const db = supabaseAdmin;
  const log: Log = opts?.log ?? (() => {});
  const max = opts?.maxMailboxes ?? 30;

  const { data: mbs } = await db
    .from('client_mailbox_accounts')
    .select(COLS)
    .eq('status', 'verified')
    .order('imap_checked_at', { ascending: true, nullsFirst: true })
    .limit(max);

  if (!mbs?.length) return false;

  let any = false;
  for (const mb of mbs as (ReplyMailboxRow & { status: string })[]) {
    const nowIso = new Date().toISOString();
    try {
      const result = await fetchNewReplies(mb);
      if (!result) {
        await db.from('client_mailbox_accounts').update({ imap_checked_at: nowIso }).eq('id', mb.id);
        continue;
      }

      if (result.replies.length) {
        const rows = result.replies.map((r) => ({
          client_user_id: mb.client_user_id,
          mailbox_id: mb.id,
          uid: r.uid,
          from_email: r.fromEmail ? r.fromEmail.toLowerCase() : null,
          from_name: r.fromName,
          subject: r.subject,
          body: r.body,
          message_id: r.messageId,
          in_reply_to: r.inReplyTo,
          received_at: r.receivedAt,
        }));
        await db.from('client_byo_replies').upsert(rows, { onConflict: 'mailbox_id,uid', ignoreDuplicates: true });

        const fromEmails = rows.map((r) => r.from_email).filter((e): e is string => !!e);
        await matchToCampaigns(mb.id, fromEmails);

        any = true;
        log('info', `BYO replies: +${result.replies.length} from ${mb.email}`);
      }

      await db
        .from('client_mailbox_accounts')
        .update({
          imap_last_uid: result.newLastUid,
          imap_uidvalidity: result.uidValidity,
          imap_checked_at: nowIso,
        })
        .eq('id', mb.id);
    } catch (e) {
      log('warn', `BYO replies failed for ${mb.email}: ${e instanceof Error ? e.message : String(e)}`);
      await db.from('client_mailbox_accounts').update({ imap_checked_at: nowIso }).eq('id', mb.id);
    }
  }

  return any;
}

/** Помечает ответы как «от лида, которому мы писали с этого ящика». */
async function matchToCampaigns(mailboxId: string, fromEmails: string[]): Promise<void> {
  if (!supabaseAdmin || !fromEmails.length) return;
  const db = supabaseAdmin;
  const uniq = [...new Set(fromEmails)];

  const { data: sent } = await db
    .from('client_byo_messages')
    .select('to_email')
    .eq('mailbox_id', mailboxId)
    .in('to_email', uniq);

  const contacted = new Set((sent ?? []).map((s) => String(s.to_email).toLowerCase()));
  for (const email of uniq) {
    if (contacted.has(email)) {
      await db
        .from('client_byo_replies')
        .update({ matched_to_email: email })
        .eq('mailbox_id', mailboxId)
        .eq('from_email', email);
    }
  }
}

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ThreadContext } from '@/lib/instantly/leadQualifier';
import type { Email } from '@/lib/instantly/types';

/**
 * Переписка «Рассылки» в виде, который понимает квалификатор Instantly
 * (lib/instantly/leadQualifier.ts): наши письма — ue_type 1, ответы — 2.
 *
 * Квалификатор сам за перепиской не ходит, если передать ему готовый
 * контекст (prefetchedContext): у «Рассылки» вся история лежит в нашей базе,
 * и Instantly тут ни при чём.
 */

interface MessageRow {
  id: string;
  subject: string | null;
  body: string | null;
  to_email: string;
  sent_at: string | null;
  mailbox_id: string;
}

interface ReplyRow {
  id: string;
  from_email: string | null;
  subject: string | null;
  body: string | null;
  kind: string;
  received_at: string | null;
  created_at: string;
}

export interface SenderThread {
  context: ThreadContext;
  /** Текст оцениваемого ответа — для ТГ и вкладки «Квалификация». */
  replySubject: string | null;
  replyBody: string;
  replyFrom: string | null;
}

function replyTime(row: ReplyRow): string {
  return row.received_at ?? row.created_at;
}

/**
 * Контекст для одного ответа: только письма ДО него. Более поздние ответы того
 * же человека в историю не идут — квалификатор оценивает этот ответ так, как
 * он выглядел в момент прихода.
 */
export async function loadSenderThread(
  db: SupabaseClient,
  replyId: string,
  recipientId: string,
): Promise<SenderThread | null> {
  const [{ data: replies, error: repliesError }, { data: messages, error: messagesError }, { data: mailboxes }] =
    await Promise.all([
      db
        .from('sender_replies')
        .select('id, from_email, subject, body, kind, received_at, created_at')
        .eq('recipient_id', recipientId)
        .order('created_at')
        .limit(200),
      db
        .from('sender_messages')
        .select('id, subject, body, to_email, sent_at, mailbox_id')
        .eq('recipient_id', recipientId)
        .eq('status', 'sent')
        .order('sent_at')
        .limit(200),
      db.from('sender_recipients').select('mailbox_id, sender_mailboxes(email)').eq('id', recipientId).maybeSingle(),
    ]);
  if (repliesError) throw new Error(`sender_replies: ${repliesError.message}`);
  if (messagesError) throw new Error(`sender_messages: ${messagesError.message}`);

  const allReplies = (replies ?? []) as ReplyRow[];
  const reply = allReplies.find((r) => r.id === replyId);
  if (!reply) return null;

  const mailboxJoin = (mailboxes as { sender_mailboxes?: { email?: string } | { email?: string }[] | null } | null)
    ?.sender_mailboxes;
  const ourAddress = (Array.isArray(mailboxJoin) ? mailboxJoin[0]?.email : mailboxJoin?.email) ?? undefined;

  const at = replyTime(reply);
  const outbound: Email[] = ((messages ?? []) as MessageRow[])
    .filter((m) => m.sent_at && m.sent_at <= at)
    .map((m) => ({
      id: m.id,
      ue_type: 1,
      subject: m.subject ?? undefined,
      body: { text: m.body ?? '' },
      timestamp_email: m.sent_at ?? undefined,
      from_address_email: ourAddress,
      to_address_email_list: m.to_email,
    }));
  const earlierReplies: Email[] = allReplies
    .filter((r) => r.id !== reply.id && r.kind === 'human' && replyTime(r) < at)
    .map((r) => ({
      id: r.id,
      ue_type: 2,
      subject: r.subject ?? undefined,
      body: { text: r.body ?? '' },
      timestamp_email: replyTime(r),
      from_address_email: r.from_email ?? undefined,
    }));

  const replyEmail: Email = {
    id: reply.id,
    ue_type: 2,
    subject: reply.subject ?? undefined,
    body: { text: reply.body ?? '' },
    timestamp_email: at,
    from_address_email: reply.from_email ?? undefined,
    to_address_email_list: ourAddress,
  };

  const threadEmails = [...outbound, ...earlierReplies, replyEmail].sort(
    (a, b) => new Date(a.timestamp_email ?? 0).getTime() - new Date(b.timestamp_email ?? 0).getTime(),
  );

  return {
    context: {
      replyEmail,
      threadEmails,
      lastOutbound: outbound.at(-1) ?? null,
    },
    replySubject: reply.subject,
    replyBody: reply.body ?? '',
    replyFrom: reply.from_email,
  };
}

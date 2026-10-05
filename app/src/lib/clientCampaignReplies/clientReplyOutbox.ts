import { supabaseInstantly } from '@/lib/supabaseInstantly';
import type { ThreadMessage } from './types';

type OutboxStatus = 'sending' | 'accepted' | 'failed';

interface OutboxRow {
  id: string;
  from_email: string;
  to_email: string;
  all_recipients: string[];
  subject: string;
  body_text: string;
  status: OutboxStatus;
  created_at: string;
  accepted_at: string | null;
}

/** Persist the send intent before calling /emails/test: an untracked send is forbidden. */
export async function prepareClientReplyOutbox(input: {
  clientUserId: string;
  campaignId: string;
  sourceEmailId: string;
  leadEmail: string;
  fromEmail: string;
  toEmail: string;
  allRecipients: string[];
  subject: string;
  bodyText: string;
}): Promise<string> {
  if (!supabaseInstantly) throw new Error('Журнал исходящих недоступен. Ответ не отправлен.');
  const id = crypto.randomUUID();
  const { error } = await supabaseInstantly.from('client_reply_outbox').insert({
    id,
    client_user_id: input.clientUserId,
    campaign_id: input.campaignId,
    source_email_id: input.sourceEmailId,
    lead_email: input.leadEmail.toLowerCase(),
    from_email: input.fromEmail.toLowerCase(),
    to_email: input.toEmail.toLowerCase(),
    all_recipients: input.allRecipients.map((address) => address.toLowerCase()),
    subject: input.subject,
    body_text: input.bodyText,
    status: 'sending',
  });
  if (error) throw new Error(`Журнал исходящих недоступен. Ответ не отправлен: ${error.message}`);
  return id;
}

export async function finishClientReplyOutbox(id: string, status: 'accepted' | 'failed'): Promise<void> {
  if (!supabaseInstantly) throw new Error('Журнал исходящих недоступен');
  const { error } = await supabaseInstantly.from('client_reply_outbox').update({
    status,
    ...(status === 'accepted' ? { accepted_at: new Date().toISOString() } : { failed_at: new Date().toISOString() }),
  }).eq('id', id).eq('status', 'sending');
  if (error) throw new Error(`Не удалось обновить журнал исходящих: ${error.message}`);
}

export async function readClientReplyOutbox(input: {
  clientUserId: string;
  campaignId: string;
  leadEmail: string;
}): Promise<ThreadMessage[]> {
  if (!supabaseInstantly) return [];
  const { data, error } = await supabaseInstantly
    .from('client_reply_outbox')
    .select('id, from_email, to_email, all_recipients, subject, body_text, status, created_at, accepted_at')
    .eq('client_user_id', input.clientUserId)
    .eq('campaign_id', input.campaignId)
    .eq('lead_email', input.leadEmail.toLowerCase())
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw new Error(`Не удалось загрузить журнал исходящих: ${error.message}`);
  return ((data ?? []) as OutboxRow[]).map((row) => ({
    id: `outbox:${row.id}`,
    direction: 'outbound',
    timestamp: row.accepted_at ?? row.created_at,
    subject: row.subject,
    from_email: row.from_email,
    from_name: null,
    body_text: row.body_text.slice(0, 20_000),
    image_links: [],
    to_recipients: row.all_recipients.map((email) => ({ email, name: null })),
    cc_recipients: [],
    delivery_status: row.status,
  }));
}

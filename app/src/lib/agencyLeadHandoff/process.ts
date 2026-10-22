import type { SupabaseClient } from '@supabase/supabase-js';
import { getEmail, listEmails, replyToEmail } from '@/lib/instantly/client';
import { getBodyText } from '@/lib/instantly/leadQualifier';
import { readInstantlyEmailReadDeferral } from '@/lib/instantly/emailReadDeferral';
import { isOwnAgencyCampaign } from '@/lib/instantly/ownAgencyCampaign';
import { computeReplyAllCc, mergeCcLists } from '@/lib/clientCampaignReplies/participants';
import { textToReplyHtml } from '@/lib/clientCampaignReplies/bodyHtml';
import { buildMessageId } from '@/lib/mail/message';
import { handoffText, loadHandoffSettings, type AgencyHandoffSettings, type HandoffScope } from './settings';

type Log = (level: 'info' | 'warn' | 'error', message: string) => void;
interface HandoffRow {
  id: string;
  source: 'sender' | 'instantly';
  source_id: string;
  scope: HandoffScope;
  lead_email: string;
  recipient_id: string | null;
  attempts: number;
  next_attempt_at: string;
  created_at: string;
}

class SkipHandoff extends Error {}
const MAX_HISTORY_PAGES = 20;
const norm = (s: string) => s.trim().toLowerCase();
const stamp = (e: { timestamp_email?: string; timestamp_created?: string }) =>
  Date.parse(e.timestamp_email ?? e.timestamp_created ?? '') || 0;

/** Include actual correspondence so the new CC recipient can take over. */
function withHistory(text: string, history: string): string {
  return `${text}\n\n${history.slice(-20_000).split(/\r?\n/).map(line => `> ${line}`).join('\n')}`;
}
function ccFor(settings: AgencyHandoffSettings, sender: string, lead: string): string[] {
  const cc = settings.cc_emails.filter(email => norm(email) !== norm(sender) && norm(email) !== norm(lead));
  if (!cc.length) throw new Error('В копии нет отдельной почты ответственного');
  return cc;
}
async function patch(db: SupabaseClient, id: string, values: Record<string, unknown>): Promise<void> {
  const { error } = await db.from('agency_lead_handoffs')
    .update({ ...values, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw new Error(error.message);
}

async function queueSender(db: SupabaseClient, row: HandoffRow, settings: AgencyHandoffSettings): Promise<void> {
  const [recipientResult, replyResult, manualResult, messagesResult, folderResult, latestResult] = await Promise.all([
    db.from('sender_recipients').select('email, campaign_id, mailbox_id, status, lead_verdict, lead_verdict_source, sender_mailboxes(email)')
      .eq('id', row.recipient_id!).maybeSingle(),
    db.from('sender_replies').select('from_email, subject, body, message_id, created_at, received_at, kind')
      .eq('id', row.source_id).eq('recipient_id', row.recipient_id!).maybeSingle(),
    db.from('sender_manual_messages').select('id, agency_handoff_id, body, cc_emails')
      .eq('recipient_id', row.recipient_id!).limit(100),
    db.from('sender_messages').select('body, subject, sent_at').eq('recipient_id', row.recipient_id!)
      .eq('status', 'sent').order('sent_at').limit(50),
    db.from('sender_reply_qualifications').select('status, sender_campaigns(sender_folders(key, leads_enabled, leads_telegram))')
      .eq('reply_id', row.source_id).maybeSingle(),
    db.from('sender_replies').select('id').eq('recipient_id', row.recipient_id!)
      .in('kind', ['human', 'unknown']).order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  for (const result of [recipientResult, replyResult, manualResult, messagesResult, folderResult, latestResult]) {
    if (result.error) throw new Error(result.error.message);
  }
  const recipient = recipientResult.data;
  const reply = replyResult.data;
  const folders = folderResult.data?.sender_campaigns as unknown as { sender_folders?: { key: string; leads_enabled: boolean; leads_telegram: boolean } } | null;
  if (folderResult.data?.status !== 'lead' || folders?.sender_folders?.key !== row.scope ||
    !folders.sender_folders.leads_enabled || !folders.sender_folders.leads_telegram) throw new SkipHandoff('Квалификация или передача выключена');
  if (!recipient || !reply || reply.kind !== 'human') throw new SkipHandoff('Переписка удалена или ответ служебный');
  if (latestResult.data?.id !== row.source_id) throw new SkipHandoff('После квалификации пришёл новый ответ: нужна ручная передача');
  if (['unsubscribed', 'bounced', 'stopped'].includes(recipient.status) ||
    (recipient.lead_verdict_source === 'manual' && recipient.lead_verdict === 'not_lead')) {
    throw new SkipHandoff('Переписка остановлена или отмечена «не лид»');
  }
  if (manualResult.data?.some(m => m.agency_handoff_id !== row.id)) throw new SkipHandoff('В переписке уже есть ответ оператора');
  const existing = manualResult.data?.find(m => m.agency_handoff_id === row.id);
  if (existing) {
    // The previous enqueue succeeded but its journal update failed. Keep the
    // exact saved recipients/body even if settings changed between passes.
    await patch(db, row.id, { status: 'queued', body: existing.body, cc_emails: existing.cc_emails, error: null });
    return;
  }
  const mailbox = recipient.sender_mailboxes as unknown as { email: string } | null;
  if (!mailbox?.email || !recipient.mailbox_id || !reply.message_id) throw new Error('Не найден ящик или идентификатор входящего письма');
  const to = norm(reply.from_email || recipient.email);
  if (to !== norm(row.lead_email)) throw new SkipHandoff('Ответ пришёл с другого адреса: нужна ручная передача');
  const cc = ccFor(settings, mailbox.email, to);
  const text = handoffText(settings, row.id);
  const history = [
    ...(messagesResult.data ?? []).map(m => `${mailbox.email}:\n${m.body ?? ''}`),
    `${to}:\n${reply.body ?? ''}`,
  ].join('\n\n');
  const subject = reply.subject || messagesResult.data?.[0]?.subject || '';
  // The queue ID is stable: a crash between insert and status update cannot create a second email.
  const { error } = await db.from('sender_manual_messages').upsert({
    id: row.id, agency_handoff_id: row.id, campaign_id: recipient.campaign_id,
    recipient_id: row.recipient_id, mailbox_id: recipient.mailbox_id,
    to_email: to, cc_emails: cc, subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    body: withHistory(text, history), message_id: buildMessageId(mailbox.email),
    in_reply_to: reply.message_id, status: 'queued',
  }, { onConflict: 'id', ignoreDuplicates: true });
  if (error) throw new Error(error.message);
  await patch(db, row.id, { status: 'queued', body: text, cc_emails: cc, error: null });
}

async function sendInstantly(db: SupabaseClient, row: HandoffRow, settings: AgencyHandoffSettings): Promise<void> {
  const { data: q, error } = await db.from('own_reply_qualifications')
    .select('status, campaign_id, campaign_name, lead_email, thread_id').eq('email_id', row.source_id).maybeSingle();
  if (error) throw new Error(error.message);
  const { data: own, error: ownError } = await db.from('own_reply_lead_settings').select('enabled').eq('id', 1).maybeSingle();
  if (ownError) throw new Error(ownError.message);
  if (!own?.enabled || q?.status !== 'lead' || !isOwnAgencyCampaign(q.campaign_name) || norm(q.lead_email) !== norm(row.lead_email)) {
    throw new SkipHandoff('Квалификация выключена или лид снят с обработки');
  }
  const requestOptions = { accountId: 'main', consumer: 'agency_lead_handoff',
    requestPriority: 'bulk' as const, retryRateLimits: false, timeoutMs: 20_000, timeoutIncludesBody: true };
  const original = await getEmail(row.source_id, requestOptions);
  const sender = original.eaccount;
  // Отвечаем тому, кто написал: это может быть не тот адрес, на который мы слали (коллега, пересылка).
  const replier = norm(original.from_address_email ?? '');
  if (!sender || !replier.includes('@') || replier === norm(sender) || original.campaign_id !== q.campaign_id) {
    throw new SkipHandoff('Не удалось подтвердить отправителя и кампанию переписки');
  }
  // Читаем всю переписку постранично: менеджеру нужна она целиком, а не первые 100 писем.
  const all: Awaited<ReturnType<typeof listEmails>>['items'] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
    const response = await listEmails({ campaign_id: q.campaign_id, search: q.lead_email,
      mode: 'emode_all', sort_order: 'desc', limit: 100, starting_after: after }, requestOptions);
    all.push(...(response.items ?? []));
    after = response.next_starting_after || undefined;
    if (!after) break;
  }
  if (after) throw new Error(`Переписка длиннее ${MAX_HISTORY_PAGES * 100} писем — нужна ручная передача`);
  const thread = all.filter(e => original.thread_id
    ? e.thread_id === original.thread_id
    : [norm(row.lead_email), replier].includes(norm(e.from_address_email ?? '')) || norm(e.lead ?? '') === norm(row.lead_email));
  if (!thread.some(e => e.id === original.id)) throw new Error('Входящее не найдено в живой переписке');
  if (thread.some(e => stamp(e) > stamp(original))) {
    throw new SkipHandoff('После квалификации переписка продолжилась: нужна ручная передача');
  }
  const { data: manual, error: manualError } = await db.from('reply_personalization_drafts').select('id')
    .eq('campaign_id', q.campaign_id).eq('lead_email', row.lead_email).eq('status', 'sent')
    .gte('sent_at', new Date(stamp(original)).toISOString()).limit(1);
  if (manualError) throw new Error(manualError.message);
  if (manual?.length) throw new SkipHandoff('В переписке уже ответил оператор');
  const cc = mergeCcLists(ccFor(settings, sender, replier), computeReplyAllCc(original, { eaccount: sender, leadEmail: replier }));
  const text = handoffText(settings, row.id);
  const history = [...thread.filter(e => e.id !== original.id), original]
    .sort((a, b) => stamp(a) - stamp(b))
    .map(e => `${e.from_address_email || (e.ue_type === 2 ? replier : sender)}:\n${getBodyText(e.body)}`).join('\n\n');
  const body = withHistory(text, history);
  // Persist the external side-effect boundary. Never replay an interrupted/ambiguous POST.
  const { data: claimed, error: claimError } = await db.from('agency_lead_handoffs')
    .update({ status: 'sending', body: text, cc_emails: cc, updated_at: new Date().toISOString() })
    .eq('id', row.id).eq('status', 'pending').eq('next_attempt_at', row.next_attempt_at).select('id');
  if (claimError) throw new Error(claimError.message);
  if (!claimed?.length) return;
  try {
    await replyToEmail({ reply_to_uuid: original.id, eaccount: sender,
      subject: /^re:/i.test(original.subject ?? '') ? original.subject! : `Re: ${original.subject ?? ''}`,
      body: { text: body, html: textToReplyHtml(body) }, cc_address_email_list: cc.join(', '),
    }, { accountId: 'main', consumer: 'agency_lead_handoff', retryRateLimits: false,
      timeoutMs: 20_000, timeoutIncludesBody: true });
  } catch (err) {
    await patch(db, row.id, { status: 'unknown', error: `Отправка не подтверждена, проверьте исходящие: ${String(err).slice(0, 400)}` });
    return;
  }
  // Failure to persist success must leave `sending`, never put the email back in pending.
  await patch(db, row.id, { status: 'sent', sent_at: new Date().toISOString(), error: null });
}

export async function runAgencyLeadHandoffs(db: SupabaseClient, log: Log): Promise<void> {
  const settings = await loadHandoffSettings(db);
  const { error: enqueueError } = await db.rpc('enqueue_agency_lead_handoffs');
  if (enqueueError) throw new Error(enqueueError.message);
  const active = settings.filter(s => s.enabled && s.cc_emails.length).map(s => s.scope);
  if (!active.length) return;
  const { data, error } = await db.from('agency_lead_handoffs').select('*').eq('status', 'pending').in('scope', active)
    .lte('next_attempt_at', new Date().toISOString()).order('created_at').limit(5);
  if (error) throw new Error(error.message);
  for (const row of (data ?? []) as HandoffRow[]) {
    const config = settings.find(s => s.scope === row.scope);
    if (!config?.enabled || !config.cc_emails.length) continue;
    try {
      if (!config.enabled_at || row.created_at < config.enabled_at) throw new SkipHandoff('Передача осталась от предыдущего включения');
      if (row.source === 'sender') await queueSender(db, row, config);
      else await sendInstantly(db, row, config);
    } catch (err) {
      const deferral = readInstantlyEmailReadDeferral(err);
      const attempts = row.attempts + (deferral ? 0 : 1);
      const status = err instanceof SkipHandoff ? 'skipped' : attempts >= 5 ? 'failed' : 'pending';
      // Only preparation failures are retryable; sending rows must never be reset.
      const { error: saveError } = await db.from('agency_lead_handoffs').update({ status, attempts,
        error: String(err).slice(0, 500), updated_at: new Date().toISOString(),
        next_attempt_at: new Date(Date.now() + Math.max(deferral?.retryAfterMs ?? 0, 300_000)).toISOString(),
      }).eq('id', row.id).eq('status', 'pending');
      log('warn', `Передача лида ${row.id}: ${saveError?.message || String(err)}`);
    }
  }
}

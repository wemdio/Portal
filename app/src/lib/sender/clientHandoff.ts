import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { substituteHandoffLegend } from '@/lib/instantly/handoffLegend';
import { buildMessageId } from '@/lib/mail/message';
import { normalizeRecipientEmail } from './recipientImport';
import { campaignStopListScope, loadSenderStopList, matchSenderStopList, stopListIsEmpty } from './stopLists';

/**
 * Передача лида клиенту из переписки «Рассылки» — тем же порядком, что у
 * Instantly (instantly/handoffSender): письмо лиду в тот же тред с ящика
 * переписки, клиент в копии (projects.handoff_email) вместе с теми, кого лид
 * сам поставил в ответ («ответить всем»), текст — легенда проекта, под ней
 * цитата ответа лида: клиент в треде новый, прежний диалог ему иначе не виден.
 *
 * SMTP из API-процесса не ходит: письмо ложится в sender_manual_messages и
 * уходит воркером «Рассылки» с изолированного хоста (manualWorker). Запись
 * клиенту в кабинет (client_forwarded_leads) — после того, как письмо ушло
 * (recordSenderHandoffs в воркере sender-leads): почтовые хосты базы Instantly
 * не видят, а лид в кабинете без ушедшего письма вводил бы клиента в
 * заблуждение. Один лид — одна передача (уникальный индекс в базе).
 */

interface HandoffReply {
  messageId: string | null;
  subject: string | null;
  body: string | null;
  at: string | null;
  fromName: string | null;
}

export interface SenderHandoffContext {
  recipientId: string;
  campaignId: string;
  campaignName: string;
  mailboxId: string | null;
  mailboxEmail: string | null;
  /** Кому письмо: адрес, с которого ответили, иначе адрес получателя. */
  to: string;
  /** Копия по умолчанию: адреса передачи проекта и те, кого лид поставил в ответ. */
  cc: string[];
  /** Легенда проекта как есть и включён ли у проекта ИИ-пересказ легенды. */
  legend: string;
  aiAdapt: boolean;
  /** Черновик: легенда с именем лида; ИИ-вариант строит роут, если он включён. */
  draft: string;
  projectId: string | null;
  clientUserId: string | null;
  leadName: string | null;
  companyName: string | null;
  website: string | null;
  reply: HandoffReply | null;
  firstSubject: string;
  threadMessageId: string | null;
  /** Почему передать нельзя; null — можно. */
  blocked: string | null;
}

/** Адреса через запятую, точку с запятой или пробел: годные без повторов и негодные. */
export function parseEmailList(value: string | null | undefined): { emails: string[]; invalid: string[] } {
  const emails: string[] = [];
  const invalid: string[] = [];
  for (const part of (value ?? '').split(/[\s,;]+/)) {
    if (!part) continue;
    const email = normalizeRecipientEmail(part);
    if (!email) invalid.push(part);
    else if (!emails.includes(email)) emails.push(email);
  }
  return { emails, invalid };
}

/** Адреса передачи проекта (негодные молча отбрасываются — их чинят в карточке проекта). */
export function splitHandoffEmails(value: string | null | undefined): string[] {
  return parseEmailList(value).emails;
}

/**
 * Копия передачи: клиент и те, кого лид поставил в ответ, без нашего ящика и
 * без самого адресата письма — как computeReplyAllCc + mergeCcLists у Instantly.
 */
export function mergeHandoffCc(clientCc: string[], replyParticipants: string[], exclude: string[]): string[] {
  const skip = new Set(exclude.map((email) => email.trim().toLowerCase()));
  const out: string[] = [];
  for (const raw of [...clientCc, ...replyParticipants]) {
    const email = normalizeRecipientEmail(raw);
    if (email && !skip.has(email) && !out.includes(email)) out.push(email);
  }
  return out;
}

/** Текст письма: легенда и цитата ответа лида с датой по Москве. */
export function buildSenderHandoffBody(
  text: string,
  reply: { body: string | null; at: string | null } | null,
  who: string,
): string {
  const history = (reply?.body ?? '').trim();
  if (!history) return text;
  const when = reply?.at
    ? new Date(reply.at).toLocaleString('ru-RU', {
        timeZone: 'Europe/Moscow',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
  const header = [when, who].filter(Boolean).join(', ');
  const quoted = history.split('\n').map((line) => `> ${line}`).join('\n');
  return `${text}\n\n${header ? `${header} писал(а):\n` : ''}${quoted}`;
}

const COMPANY_KEYS = ['company', 'company_name', 'компания', 'название_компании'];
const WEBSITE_KEYS = ['website', 'site', 'сайт', 'domain'];

function firstVar(vars: Record<string, string> | null, keys: string[]): string | null {
  for (const key of keys) {
    const value = vars?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Имя для приветствия и для кабинета. Ответил коллега с другого адреса — его
 * имя из ответа. Иначе имя получателя, но не название компании: в базах
 * автоаутрича «имя» часто и есть компания, а «Добрый день, ООО Ромашка» хуже,
 * чем приветствие без имени.
 */
export function handoffLeadName(opts: {
  recipientEmail: string;
  recipientName: string | null;
  replyFrom: string | null;
  replyFromName: string | null;
  companyName: string | null;
}): string | null {
  const replyName = opts.replyFromName?.trim() || null;
  if (opts.replyFrom && opts.replyFrom !== opts.recipientEmail.trim().toLowerCase()) return replyName;
  const name = opts.recipientName?.trim() || null;
  if (name && opts.companyName && name.toLowerCase() === opts.companyName.trim().toLowerCase()) return replyName;
  return name ?? replyName;
}

/** Всё, что нужно для передачи по одной переписке. null — переписки нет. */
export async function loadSenderHandoffContext(
  db: SupabaseClient,
  instantlyDb: SupabaseClient | null,
  recipientId: string,
): Promise<SenderHandoffContext | null> {
  const { data: recipient, error } = await db
    .from('sender_recipients')
    .select('id, campaign_id, email, name, vars, mailbox_id, thread_message_id, status')
    .eq('id', recipientId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!recipient) return null;

  const [{ data: campaign }, { data: firstMessage }, { data: lastReply }, { data: mailbox }, { data: previous }] = await Promise.all([
    db.from('sender_campaigns').select('id, name, project_id, client_user_id').eq('id', recipient.campaign_id).maybeSingle(),
    db.from('sender_messages').select('subject').eq('recipient_id', recipientId).eq('step_no', 1).maybeSingle(),
    db.from('sender_replies')
      .select('message_id, from_email, from_name, subject, body, received_at, created_at, to_emails, cc_emails')
      .eq('recipient_id', recipientId)
      .eq('kind', 'human')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    recipient.mailbox_id
      ? db.from('sender_mailboxes').select('id, email, status, enabled').eq('id', recipient.mailbox_id).maybeSingle()
      : Promise.resolve({ data: null }),
    db.from('sender_manual_messages')
      .select('created_at')
      .eq('recipient_id', recipientId)
      .not('handoff', 'is', null)
      .neq('status', 'failed')
      .limit(1)
      .maybeSingle(),
  ]);
  if (!campaign) return null;

  const scope = await campaignStopListScope(db, campaign);
  const { data: project } = scope.projectId
    ? await db.from('projects').select('handoff_email, handoff_legend, handoff_ai_adapt').eq('id', scope.projectId).maybeSingle()
    : { data: null };

  const vars = (recipient.vars ?? null) as Record<string, string> | null;
  const companyName = firstVar(vars, COMPANY_KEYS);
  const replyFrom = normalizeRecipientEmail(lastReply?.from_email as string | null);
  const to = replyFrom ?? String(recipient.email);
  const leadName = handoffLeadName({
    recipientEmail: String(recipient.email),
    recipientName: (recipient.name as string | null) ?? null,
    replyFrom,
    replyFromName: (lastReply?.from_name as string | null) ?? null,
    companyName,
  });
  const clientCc = splitHandoffEmails(project?.handoff_email as string | null);
  // Собственные стоп-листы «Рассылки»: адрес, закрытый после ответа, статус
  // получателя не меняет (снимаются только ждущие письма).
  const stopEmails = [...new Set([String(recipient.email).trim().toLowerCase(), to])];
  const [globalStop, campaignStop] = await Promise.all([
    db.from('sender_suppressions').select('email').in('email', stopEmails).limit(1),
    db.from('sender_campaign_suppressions').select('email')
      .eq('campaign_id', String(campaign.id)).in('email', stopEmails).limit(1),
  ]);
  const participants = [
    ...((lastReply?.to_emails as string[] | null) ?? []),
    ...((lastReply?.cc_emails as string[] | null) ?? []),
  ];
  const cc = mergeHandoffCc(clientCc, participants, [to, String(mailbox?.email ?? '')]);
  const legend = String(project?.handoff_legend ?? '').trim();

  let blocked: string | null = null;
  if (!scope.projectId) blocked = 'Кампания не привязана к проекту — передавать некому';
  else if (!clientCc.length) blocked = 'У проекта не указана почта для передачи лидов (карточка проекта, «Передача лида»)';
  else if (previous) blocked = `Лид уже передан клиенту ${new Date(String(previous.created_at)).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' })}`;
  else if (['unsubscribed', 'bounced'].includes(String(recipient.status))) blocked = 'Адресат отписался или адрес в отбое — передавать нельзя';
  else if (globalStop.error || campaignStop.error) blocked = 'Стоп-лист «Рассылки» не проверен — передайте чуть позже';
  else if (globalStop.data?.length || campaignStop.data?.length) blocked = 'Адрес в стоп-листе «Рассылки» — передавать нельзя';
  else if (!recipient.mailbox_id) blocked = 'У переписки ещё нет ящика-отправителя';
  else if (!mailbox || mailbox.status !== 'verified' || !mailbox.enabled) blocked = 'Ящик переписки недоступен — передайте после его починки';
  else if (!lastReply) blocked = 'Лид ещё не ответил — передавать пока нечего';

  // Стоп-листы клиента и проекта — как у заливки: не прочитали — не передаём.
  if (!blocked) {
    try {
      const list = await loadSenderStopList(instantlyDb, scope);
      if (list && !stopListIsEmpty(list)
        && (matchSenderStopList(list, { email: String(recipient.email), vars }) || matchSenderStopList(list, { email: to, vars }))) {
        blocked = 'Адрес в стоп-листе клиента или проекта — передавать нельзя';
      }
    } catch (e) {
      blocked = `Стоп-листы клиента и проекта не проверены: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  return {
    recipientId,
    campaignId: String(campaign.id),
    campaignName: String(campaign.name ?? ''),
    mailboxId: recipient.mailbox_id ? String(recipient.mailbox_id) : null,
    mailboxEmail: mailbox?.email ? String(mailbox.email) : null,
    to,
    cc,
    legend,
    aiAdapt: Boolean(project?.handoff_ai_adapt),
    draft: substituteHandoffLegend(legend, leadName),
    projectId: scope.projectId,
    clientUserId: scope.clientUserId,
    leadName,
    companyName,
    website: firstVar(vars, WEBSITE_KEYS),
    reply: lastReply
      ? {
          messageId: (lastReply.message_id as string | null) ?? null,
          subject: (lastReply.subject as string | null) ?? null,
          body: (lastReply.body as string | null) ?? null,
          at: ((lastReply.received_at ?? lastReply.created_at) as string | null) ?? null,
          fromName: (lastReply.from_name as string | null) ?? null,
        }
      : null,
    firstSubject: String((firstMessage as { subject?: string } | null)?.subject ?? ''),
    threadMessageId: (recipient.thread_message_id as string | null) ?? null,
    blocked,
  };
}

/** Повторная передача: уникальный индекс в базе не пустил вторую. */
export class HandoffAlreadyQueuedError extends Error {
  constructor() {
    super('Лид уже передан клиенту');
    this.name = 'HandoffAlreadyQueuedError';
  }
}

/**
 * Поставить письмо передачи в очередь и отметить получателя лидом. Что
 * записать клиенту в кабинет, лежит в самом письме (handoff) — запишет воркер,
 * когда письмо уйдёт.
 */
export async function enqueueSenderHandoff(opts: {
  db: SupabaseClient;
  ctx: SenderHandoffContext;
  text: string;
  cc: string[];
  userId: string;
}): Promise<{ messageId: string; cabinet: 'after_send' | 'no_client' }> {
  const { db, ctx, userId } = opts;
  if (ctx.blocked) throw new Error(ctx.blocked);
  const subject = /^re:/i.test(ctx.firstSubject) || !ctx.firstSubject
    ? ctx.firstSubject || 'Re: ваше письмо'
    : `Re: ${ctx.firstSubject}`;
  const body = buildSenderHandoffBody(opts.text, ctx.reply, ctx.leadName || ctx.to);

  const { data: inserted, error } = await db
    .from('sender_manual_messages')
    .insert({
      campaign_id: ctx.campaignId,
      recipient_id: ctx.recipientId,
      mailbox_id: ctx.mailboxId,
      to_email: ctx.to,
      cc_emails: opts.cc,
      subject,
      body,
      message_id: buildMessageId(String(ctx.mailboxEmail)),
      in_reply_to: ctx.reply?.messageId ?? ctx.threadMessageId,
      status: 'queued',
      created_by: userId,
      handoff: {
        client_user_id: ctx.clientUserId,
        project_id: ctx.projectId,
        forwarded_by: userId,
        campaign_id: ctx.campaignId,
        campaign_name: ctx.campaignName,
        lead_email: ctx.to,
        lead_name: ctx.leadName,
        company_name: ctx.companyName,
        website: ctx.website,
        reply_subject: ctx.reply?.subject ?? null,
        reply_body: ctx.reply?.body ?? null,
        reply_timestamp: ctx.reply?.at ?? null,
        client_email: opts.cc.join(', '),
      },
    })
    .select('id')
    .single();
  if (error?.code === '23505') throw new HandoffAlreadyQueuedError();
  if (error || !inserted) throw new Error(error?.message ?? 'Письмо передачи не поставлено в очередь');

  const at = new Date().toISOString();
  await db
    .from('sender_recipients')
    .update({ lead_verdict: 'lead', lead_verdict_source: 'manual', lead_verdict_at: at, lead_verdict_by: userId })
    .eq('id', ctx.recipientId);
  // Открытый черновик ИИ переписки больше не нужен: иначе он вернулся бы в
  // поле ответа при следующем открытии.
  await db
    .from('sender_reply_drafts')
    .update({ status: 'sent', sent_at: at, manual_message_id: inserted.id })
    .eq('recipient_id', ctx.recipientId)
    .eq('status', 'draft');

  return { messageId: String(inserted.id), cabinet: ctx.clientUserId ? 'after_send' : 'no_client' };
}

type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

const RECORD_BATCH = 50;
/** Передача «отправляется» дольше этого — воркер прервался посреди отправки. */
const STUCK_SENDING_MS = 15 * 60_000;

/**
 * Записать клиентам в кабинет ушедшие передачи: строка client_forwarded_leads
 * с forwarded_via 'sender'. Повтор после сбоя не дублирует — сначала проверка,
 * нет ли уже такой записи. Кампания без клиента — записывать некому, передача
 * просто отмечается.
 */
export async function recordSenderHandoffs(opts: {
  db: SupabaseClient;
  instantlyDb: SupabaseClient | null;
  log?: Log;
}): Promise<number> {
  const { db, instantlyDb } = opts;
  const log: Log = opts.log ?? (() => {});

  // Зависшую передачу повторно не забирают (claim): исход неизвестен, повтор
  // прислал бы второе письмо. Показываем оператору — решать ему.
  const { error: stuckError } = await db
    .from('sender_manual_messages')
    .update({
      status: 'failed',
      error: 'Исход неизвестен: отправку прервали. Письмо могло уйти — передавайте заново, только если лид и клиент его не получили',
      updated_at: new Date().toISOString(),
    })
    .not('handoff', 'is', null)
    .eq('status', 'sending')
    .lt('updated_at', new Date(Date.now() - STUCK_SENDING_MS).toISOString());
  if (stuckError) log('warn', `Зависшие передачи не отмечены: ${stuckError.message}`);

  if (!instantlyDb) return 0;

  const { data: rows, error } = await db
    .from('sender_manual_messages')
    .select('id, handoff')
    .not('handoff', 'is', null)
    .eq('status', 'sent')
    .is('handoff_recorded_at', null)
    .order('sent_at')
    .limit(RECORD_BATCH);
  if (error) throw new Error(`передачи для кабинета не прочитаны: ${error.message}`);

  let recorded = 0;
  for (const row of rows ?? []) {
    const handoff = (row.handoff ?? {}) as Record<string, unknown>;
    try {
      if (handoff.client_user_id) {
        const { data: existing, error: findError } = await instantlyDb
          .from('client_forwarded_leads')
          .select('id')
          .eq('client_user_id', String(handoff.client_user_id))
          .eq('campaign_id', String(handoff.campaign_id))
          .eq('forwarded_via', 'sender')
          .eq('lead_email', String(handoff.lead_email))
          .limit(1);
        if (findError) throw new Error(findError.message);
        if (!existing?.length) {
          const { error: insertError } = await instantlyDb
            .from('client_forwarded_leads')
            .insert({ ...handoff, status: 'lead', forwarded_via: 'sender' });
          if (insertError) throw new Error(insertError.message);
          recorded += 1;
        }
      }
      const { error: markError } = await db
        .from('sender_manual_messages')
        .update({ handoff_recorded_at: new Date().toISOString() })
        .eq('id', row.id);
      if (markError) throw new Error(markError.message);
    } catch (e) {
      log('warn', `Передача ${row.id}: лид не записан в кабинет клиента — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return recorded;
}

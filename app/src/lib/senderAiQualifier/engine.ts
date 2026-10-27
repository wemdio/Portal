import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildMessageId } from '@/lib/mail/message';
import { withHistory } from '@/lib/agencyLeadHandoff/process';
import { loadHandoffSettings } from '@/lib/agencyLeadHandoff/settings';
import { isWithinWindow, nextWindowSlot, type SendWindow } from '@/lib/sender/sendWindow';
import { stripQuoted } from '@/lib/senderLeads/telegram';
import type { Log } from '@/lib/senderLeads/process';
import { aiQualifierConfig, requestAiStep, type AiPromptInput } from './ai';
import { hasOpenAmoDeal } from './amo';
import { decideStep, reminderDueAt, replyDueAt } from './decide';
import { MAX_AI_ATTEMPTS, MAX_AI_LETTERS, type AiConversationRow, type AiFolderKey, type AiState } from './types';

/**
 * Движок квалифицирующего ИИ: запускает разговор по ответу с интересом и
 * делает следующий ход, когда пришёл ответ лида или пора напомнить.
 * Письма ставит в очередь sender_manual_messages (by_ai) — SMTP на sender-хостах.
 * Любой сбой движка оставляет лида на прежнем пути: без разговора deliverLeads
 * отдаёт его менеджерам как раньше.
 */

const BATCH = 20;
const MAX_ACTIVE = 500;
const MAX_HISTORY_TEXT = 3000;
const ERROR_RETRY_MS = 10 * 60_000;
const CLOSED_RECIPIENT = ['unsubscribed', 'bounced', 'stopped'];

interface FolderRow {
  id: string;
  key: AiFolderKey;
  timezone: string;
  send_hour_from: number;
  send_hour_to: number;
  send_weekdays: number[];
  ai_enabled: boolean;
  ai_enabled_at: string | null;
  ai_offer_text: string | null;
  leads_enabled: boolean;
  leads_telegram: boolean;
}

interface ReplyRow {
  id: string;
  recipient_id: string;
  from_email: string | null;
  subject: string | null;
  body: string | null;
  message_id: string | null;
  received_at: string | null;
  created_at: string;
}

interface RecipientRow {
  id: string;
  email: string;
  status: string;
  mailbox_id: string | null;
  lead_verdict_source: string | null;
  reply_language: string | null;
  sender_mailboxes: { email: string } | null;
}

export interface AiPassResult {
  started: number;
  letters: number;
  handedOff: number;
  closed: number;
}

const FOLDER_SELECT = 'id, key, timezone, send_hour_from, send_hour_to, send_weekdays, ai_enabled, ai_enabled_at, ai_offer_text, leads_enabled, leads_telegram';
const REPLY_SELECT = 'id, recipient_id, from_email, subject, body, message_id, received_at, created_at';

function windowOf(folder: FolderRow): SendWindow {
  return {
    timezone: folder.timezone,
    sendHourFrom: folder.send_hour_from,
    sendHourTo: folder.send_hour_to,
    sendWeekdays: folder.send_weekdays,
  };
}

const replyAt = (r: ReplyRow) => new Date(r.received_at ?? r.created_at);
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);

async function patchConversation(db: SupabaseClient, recipientId: string, values: Partial<AiConversationRow>): Promise<void> {
  const { error } = await db.from('sender_ai_conversations')
    .update({ ...values, updated_at: new Date().toISOString() })
    .eq('recipient_id', recipientId);
  if (error) throw new Error(`sender_ai_conversations: ${error.message}`);
}

/** Папки автоаутрича с включённым ИИ: id папки → папка; id рассылки → id папки. */
async function loadAiFolders(db: SupabaseClient): Promise<{ folders: Map<string, FolderRow>; campaignFolder: Map<string, string> }> {
  const folders = new Map<string, FolderRow>();
  const campaignFolder = new Map<string, string>();
  const { data, error } = await db.from('sender_folders').select(FOLDER_SELECT).in('key', ['auto_ru', 'auto_en']);
  if (error) throw new Error(`sender_folders: ${error.message}`);
  for (const f of (data ?? []) as FolderRow[]) folders.set(f.id, f);
  if (!folders.size) return { folders, campaignFolder };
  const { data: campaigns, error: campaignError } = await db.from('sender_campaigns')
    .select('id, folder_id').in('folder_id', [...folders.keys()]);
  if (campaignError) throw new Error(`sender_campaigns: ${campaignError.message}`);
  for (const c of (campaigns ?? []) as Array<{ id: string; folder_id: string }>) campaignFolder.set(c.id, c.folder_id);
  return { folders, campaignFolder };
}

/** Ответил ли оператор с портала: ручное письмо, не автопередача, не передача клиенту и не ИИ. */
async function hasOperatorMessage(db: SupabaseClient, recipientId: string): Promise<boolean> {
  const { data, error } = await db.from('sender_manual_messages').select('id')
    .eq('recipient_id', recipientId).is('agency_handoff_id', null).is('handoff', null).eq('by_ai', false).limit(1);
  if (error) throw new Error(`sender_manual_messages: ${error.message}`);
  return Boolean(data?.length);
}

async function loadRecipient(db: SupabaseClient, recipientId: string): Promise<RecipientRow | null> {
  const { data, error } = await db.from('sender_recipients')
    .select('id, email, status, mailbox_id, lead_verdict_source, reply_language, sender_mailboxes(email)')
    .eq('id', recipientId).maybeSingle();
  if (error) throw new Error(`sender_recipients: ${error.message}`);
  return (data as unknown as RecipientRow | null) ?? null;
}

/** Переписка для модели и для цитаты в письме: наши письма, письма лида и ответы с портала. */
export async function loadConversationHistory(db: SupabaseClient, recipientId: string): Promise<AiPromptInput['history']> {
  const [messages, replies, manual] = await Promise.all([
    db.from('sender_messages').select('body, sent_at').eq('recipient_id', recipientId).eq('status', 'sent').order('sent_at').limit(50),
    db.from('sender_replies').select('body, received_at, created_at').eq('recipient_id', recipientId).eq('kind', 'human').order('created_at').limit(50),
    db.from('sender_manual_messages').select('body, sent_at').eq('recipient_id', recipientId).eq('status', 'sent').order('sent_at').limit(50),
  ]);
  for (const r of [messages, replies, manual]) if (r.error) throw new Error(`история переписки: ${r.error.message}`);
  const clip = (text: string | null) => (stripQuoted(text ?? '') || (text ?? '').trim()).slice(0, MAX_HISTORY_TEXT);
  const items: AiPromptInput['history'] = [
    ...(messages.data ?? []).map((m) => ({ from: 'us' as const, at: m.sent_at as string | null, text: clip(m.body) })),
    ...(manual.data ?? []).map((m) => ({ from: 'us' as const, at: m.sent_at as string | null, text: clip(m.body) })),
    ...(replies.data ?? []).map((r) => ({ from: 'lead' as const, at: (r.received_at ?? r.created_at) as string | null, text: clip(r.body) })),
  ];
  return items.filter((m) => m.text).sort((a, b) => Date.parse(a.at ?? '') - Date.parse(b.at ?? ''));
}

/** Ответы с интересом в папках с ИИ → новые разговоры. Не подошёл — лид идёт прежним путём. */
async function startConversations(
  db: SupabaseClient, folders: Map<string, FolderRow>, campaignFolder: Map<string, string>,
): Promise<number> {
  const campaignIds = [...campaignFolder.entries()]
    .filter(([, folderId]) => folders.get(folderId)?.ai_enabled)
    .map(([campaignId]) => campaignId);
  if (!campaignIds.length) return 0;

  const { data, error } = await db.from('sender_reply_qualifications')
    .select('reply_id, recipient_id, campaign_id, qualified_at')
    .eq('status', 'lead').is('tg_sent_at', null).lt('tg_attempts', 5)
    .in('campaign_id', campaignIds)
    .order('qualified_at').limit(BATCH);
  if (error) throw new Error(`sender_reply_qualifications: ${error.message}`);

  let started = 0;
  for (const row of (data ?? []) as Array<{ reply_id: string; recipient_id: string; campaign_id: string; qualified_at: string | null }>) {
    const folder = folders.get(campaignFolder.get(row.campaign_id) ?? '');
    if (!folder?.ai_enabled || !folder.ai_enabled_at || !folder.leads_enabled || !folder.leads_telegram) continue;
    if (!row.qualified_at || row.qualified_at < folder.ai_enabled_at) continue;

    const [existing, sent, recipient, reply] = await Promise.all([
      db.from('sender_ai_conversations').select('recipient_id').eq('recipient_id', row.recipient_id).maybeSingle(),
      db.from('sender_reply_qualifications').select('reply_id').eq('recipient_id', row.recipient_id).not('tg_sent_at', 'is', null).limit(1),
      loadRecipient(db, row.recipient_id),
      db.from('sender_replies').select(REPLY_SELECT).eq('id', row.reply_id).maybeSingle(),
    ]);
    if (existing.error || sent.error || reply.error) throw new Error((existing.error ?? sent.error ?? reply.error)!.message);
    if (existing.data || sent.data?.length || !recipient || !reply.data) continue;
    if (CLOSED_RECIPIENT.includes(recipient.status) || recipient.lead_verdict_source === 'manual') continue;
    if (await hasOperatorMessage(db, row.recipient_id)) continue;
    const r = reply.data as ReplyRow;
    if (await hasOpenAmoDeal(db, r.from_email || recipient.email)) continue;

    const { error: insertError } = await db.from('sender_ai_conversations').upsert({
      recipient_id: row.recipient_id,
      campaign_id: row.campaign_id,
      folder_key: folder.key,
      trigger_reply_id: row.reply_id,
      next_action_at: replyDueAt(replyAt(r), windowOf(folder)).toISOString(),
    }, { onConflict: 'recipient_id', ignoreDuplicates: true });
    if (insertError) throw new Error(`sender_ai_conversations insert: ${insertError.message}`);
    started += 1;
  }
  return started;
}

/**
 * Один ход — один id письма: (получатель, письмо лида, номер письма ИИ). Если
 * ход упал после постановки письма в очередь, повтор хода не создаст второе.
 */
function letterId(conv: AiConversationRow, replyId: string): string {
  const h = createHash('sha1').update(`${conv.recipient_id}:${replyId}:${conv.ai_messages}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

interface LetterInput {
  conv: AiConversationRow;
  recipient: RecipientRow;
  replyTo: ReplyRow;
  text: string;
  cc: string[];
  history: AiPromptInput['history'];
}

/** Письмо ИИ в очередь «Рассылки»: тот же ящик, та же переписка. */
async function enqueueAiLetter(db: SupabaseClient, input: LetterInput): Promise<void> {
  const mailbox = input.recipient.sender_mailboxes?.email;
  if (!mailbox || !input.recipient.mailbox_id || !input.replyTo.message_id) {
    throw new Error('Не найден ящик или идентификатор письма лида');
  }
  const to = (input.replyTo.from_email || input.recipient.email).trim().toLowerCase();
  const subject = input.replyTo.subject?.trim() || '';
  const quoted = input.history.map((m) => `${m.from === 'us' ? mailbox : to}:\n${m.text}`).join('\n\n');
  const { error } = await db.from('sender_manual_messages').upsert({
    id: letterId(input.conv, input.replyTo.id),
    by_ai: true,
    status: 'queued',
    campaign_id: input.conv.campaign_id,
    recipient_id: input.conv.recipient_id,
    mailbox_id: input.recipient.mailbox_id,
    to_email: to,
    cc_emails: input.cc,
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    body: withHistory(input.text, quoted),
    message_id: buildMessageId(mailbox),
    in_reply_to: input.replyTo.message_id,
  }, { onConflict: 'id', ignoreDuplicates: true });
  if (error) throw new Error(`sender_manual_messages: ${error.message}`);
}

/** Сбой хода: пауза, после MAX_AI_ATTEMPTS — лид менеджерам прежним путём. */
async function recordFailure(db: SupabaseClient, conv: AiConversationRow, err: unknown, log: Log): Promise<void> {
  const attempts = conv.attempts + 1;
  const message = errorText(err);
  if (attempts >= MAX_AI_ATTEMPTS) {
    await patchConversation(db, conv.recipient_id, { state: 'failed', attempts, last_error: message, next_action_at: null });
    await releaseToManagers(db, conv);
    log('warn', `ИИ-квалификатор: разговор ${conv.recipient_id} передан менеджерам после сбоев: ${message}`);
    return;
  }
  await patchConversation(db, conv.recipient_id, {
    attempts, last_error: message, next_action_at: new Date(Date.now() + ERROR_RETRY_MS).toISOString(),
  });
  log('warn', `ИИ-квалификатор: ход ${conv.recipient_id} не удался (попытка ${attempts}): ${message}`);
}

/** Вернуть исходный ответ в доставку: deliverLeads отдаст его в чат как раньше. */
async function releaseToManagers(db: SupabaseClient, conv: AiConversationRow): Promise<void> {
  const { error } = await db.from('sender_reply_qualifications')
    .update({ tg_attempts: 0, tg_error: null, updated_at: new Date().toISOString() })
    .eq('reply_id', conv.trigger_reply_id).is('tg_sent_at', null);
  if (error) throw new Error(`sender_reply_qualifications: ${error.message}`);
}

/** Конец разговора. Причина пишется только для остановки и сбоя — «не ответил» не ошибка. */
async function finish(db: SupabaseClient, conv: AiConversationRow, state: AiState, reason: string | null): Promise<void> {
  await patchConversation(db, conv.recipient_id, { state, next_action_at: null, last_error: reason });
}

interface StepContext {
  folder: FolderRow;
  ccEmails: string[];
  newest: ReplyRow | null;
  result: AiPassResult;
}

/** Один ход разговора; если делать пока нечего — только переносит срок. */
async function stepConversation(db: SupabaseClient, conv: AiConversationRow, ctx: StepContext): Promise<void> {
  const { folder, newest } = ctx;
  const now = new Date();

  if (!folder.ai_enabled) {
    // ИИ выключили посреди разговора — лид уходит менеджерам как раньше.
    await finish(db, conv, 'failed', 'ИИ выключен в настройках папки');
    await releaseToManagers(db, conv);
    return;
  }

  const hasNew = Boolean(newest && newest.id !== conv.last_reply_id);
  let mode: AiPromptInput['mode'];
  let due: Date;
  if (hasNew) {
    mode = 'reply';
    due = replyDueAt(replyAt(newest!), windowOf(folder));
  } else if (conv.last_ai_sent_at) {
    if (conv.reminder_sent || conv.ai_messages >= MAX_AI_LETTERS) {
      due = reminderDueAt(new Date(conv.last_ai_sent_at), folder.timezone);
      if (now >= due) await finish(db, conv, 'no_reply', null);
      else if (conv.next_action_at !== due.toISOString()) await patchConversation(db, conv.recipient_id, { next_action_at: due.toISOString() });
      return;
    }
    mode = 'reminder';
    due = reminderDueAt(new Date(conv.last_ai_sent_at), folder.timezone);
  } else {
    await finish(db, conv, 'stopped', 'письмо лида не найдено');
    return;
  }

  if (now < due) {
    if (conv.next_action_at !== due.toISOString()) await patchConversation(db, conv.recipient_id, { next_action_at: due.toISOString() });
    return;
  }
  if (!isWithinWindow(now, windowOf(folder))) {
    await patchConversation(db, conv.recipient_id, { next_action_at: nextWindowSlot(now, windowOf(folder)).toISOString() });
    return;
  }

  // Новое письмо ждёт оценки квалификатора: стоп-слова и отписку он видит раньше нас.
  if (hasNew) {
    const { data: q, error } = await db.from('sender_reply_qualifications').select('status').eq('reply_id', newest!.id).maybeSingle();
    if (error) throw new Error(`sender_reply_qualifications: ${error.message}`);
    if (!q || q.status === 'pending') return;
  }

  const recipient = await loadRecipient(db, conv.recipient_id);
  if (!recipient || CLOSED_RECIPIENT.includes(recipient.status) || recipient.lead_verdict_source === 'manual'
    || await hasOperatorMessage(db, conv.recipient_id)) {
    await finish(db, conv, 'stopped', 'переписка остановлена, отмечена вручную или ответил оператор');
    return;
  }
  if (!newest) {
    await finish(db, conv, 'stopped', 'письмо лида не найдено');
    return;
  }

  const cfg = aiQualifierConfig();
  if (!cfg) throw new Error('Ключ ИИ не настроен (SENDER_AI_QUALIFIER_API_KEY / SENDER_LEADS_AI_API_KEY)');
  const history = await loadConversationHistory(db, conv.recipient_id);
  const ownMailbox = recipient.sender_mailboxes?.email?.toLowerCase() ?? '';
  const leadAddress = (newest.from_email || recipient.email).toLowerCase();
  const cc = ctx.ccEmails.filter((e) => e.toLowerCase() !== ownMailbox && e.toLowerCase() !== leadAddress);
  const language = recipient.reply_language === 'en' || recipient.reply_language === 'ru'
    ? recipient.reply_language
    : (conv.folder_key === 'auto_en' ? 'en' : 'ru');

  const step = await requestAiStep(cfg, {
    language, mode, history, aiMessages: conv.ai_messages,
    offerText: folder.ai_offer_text ?? '', ccEmail: cc[0] ?? null,
  });
  const decision = decideStep(step, { aiMessages: conv.ai_messages, stopRequested: false });
  const processed = { last_reply_id: newest.id, attempts: 0 };

  if (decision.kind === 'no_reply') {
    await patchConversation(db, conv.recipient_id, { ...processed, state: 'no_reply', next_action_at: null, last_error: null });
    return;
  }
  if (decision.kind === 'close') {
    if (decision.letter) {
      await enqueueAiLetter(db, { conv, recipient, replyTo: newest, text: decision.letter, cc: [], history });
      ctx.result.letters += 1;
    }
    await patchConversation(db, conv.recipient_id, { ...processed, state: 'closed', summary: step.summary || null, next_action_at: null, last_error: null });
    ctx.result.closed += 1;
    return;
  }
  if (decision.kind === 'handoff') {
    await enqueueAiLetter(db, { conv, recipient, replyTo: newest, text: decision.letter, cc, history });
    await patchConversation(db, conv.recipient_id, {
      ...processed, state: 'handed_off', handoff_reply_id: newest.id, handoff_contact: decision.contact,
      summary: decision.summary || null, ai_messages: conv.ai_messages + 1, last_ai_sent_at: now.toISOString(),
      next_action_at: null, last_error: null,
    });
    // Строка этого письма становится лидом для доставки в чат и AMO: в ней контакт и выжимка.
    const reason = `Передал ИИ. Контакт: ${decision.contact}.${decision.summary ? ` ${decision.summary}` : ''}`;
    const { error } = await db.from('sender_reply_qualifications')
      .update({ status: 'lead', ai_reason: reason.slice(0, 2000), tg_attempts: 0, tg_error: null, updated_at: now.toISOString() })
      .eq('reply_id', newest.id);
    if (error) throw new Error(`sender_reply_qualifications: ${error.message}`);
    ctx.result.letters += 1;
    ctx.result.handedOff += 1;
    return;
  }
  await enqueueAiLetter(db, { conv, recipient, replyTo: newest, text: decision.letter, cc: [], history });
  await patchConversation(db, conv.recipient_id, {
    ...processed, ai_messages: conv.ai_messages + 1, last_ai_sent_at: now.toISOString(),
    reminder_sent: conv.reminder_sent || mode === 'reminder',
    next_action_at: reminderDueAt(now, folder.timezone).toISOString(), last_error: null,
  });
  ctx.result.letters += 1;
}

/** Самое свежее письмо лида у каждого получателя. */
async function newestReplies(db: SupabaseClient, recipientIds: string[]): Promise<Map<string, ReplyRow>> {
  const out = new Map<string, ReplyRow>();
  for (let i = 0; i < recipientIds.length; i += 100) {
    const { data, error } = await db.from('sender_replies').select(REPLY_SELECT)
      .in('recipient_id', recipientIds.slice(i, i + 100)).eq('kind', 'human');
    if (error) throw new Error(`sender_replies: ${error.message}`);
    for (const r of (data ?? []) as ReplyRow[]) {
      const prev = out.get(r.recipient_id);
      if (!prev || replyAt(r) > replyAt(prev)) out.set(r.recipient_id, r);
    }
  }
  return out;
}

export async function runSenderAiQualifier(db: SupabaseClient, log: Log): Promise<AiPassResult> {
  const result: AiPassResult = { started: 0, letters: 0, handedOff: 0, closed: 0 };
  const { folders, campaignFolder } = await loadAiFolders(db);
  if (!folders.size) return result;

  result.started = await startConversations(db, folders, campaignFolder);

  const { data, error } = await db.from('sender_ai_conversations').select('*')
    .eq('state', 'active').order('next_action_at').limit(MAX_ACTIVE);
  if (error) throw new Error(`sender_ai_conversations: ${error.message}`);
  const active = (data ?? []) as AiConversationRow[];
  if (!active.length) return result;

  const newest = await newestReplies(db, active.map((c) => c.recipient_id));
  const handoff = await loadHandoffSettings(db);
  const now = Date.now();
  for (const conv of active) {
    // Пауза после сбоя: следующий ход не раньше назначенного времени.
    if (conv.attempts > 0 && conv.next_action_at && Date.parse(conv.next_action_at) > now) continue;
    const folder = folders.get(campaignFolder.get(conv.campaign_id) ?? '');
    if (!folder) continue;
    const ccEmails = handoff.find((s) => s.scope === conv.folder_key)?.cc_emails ?? [];
    try {
      await stepConversation(db, conv, { folder, ccEmails, newest: newest.get(conv.recipient_id) ?? null, result });
    } catch (err) {
      await recordFailure(db, conv, err, log);
    }
  }
  return result;
}

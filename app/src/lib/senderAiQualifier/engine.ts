import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildMessageId } from '@/lib/mail/message';
import { loadRecipientProduct } from '@/lib/polzaRuOutreach/rowProduct';
import { caseAllowedForProduct, loadCases } from '@/lib/polzaRuOutreach/libraries';
import { withHistory } from '@/lib/agencyLeadHandoff/process';
import { loadHandoffSettings } from '@/lib/agencyLeadHandoff/settings';
import { isWithinWindow, nextWindowSlot, type SendWindow } from '@/lib/sender/sendWindow';
import { cancelPendingMessages, markUnsubscribed, suppressEmails } from '@/lib/sender/unsubscribe';
import { stripQuoted } from '@/lib/senderLeads/telegram';
import type { Log } from '@/lib/senderLeads/process';
import { aiQualifierConfig, productPitchOf, requestAiStep, type AiPromptInput } from './ai';
import { hasOpenAmoDeal } from './amo';
import { closeReasonOf, decideStep, parseAiStep, reminderDueAt, replyDueAt } from './decide';
import { loadEnCases } from '@/lib/polzaOutreach/caseRouter';
import { productKnowledgeText } from '@/lib/polzaRuOutreach/productKnowledge';
import { rankCaseMatches, type CaseMatchContext } from '@/lib/outreachLlm/caseMatching';
import { AI_LETTER_CANCELLED, MAX_AI_ATTEMPTS, MAX_AI_LETTERS, type AiConversationRow, type AiFolderKey, type AiState, type AiStep } from './types';

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
  lead_verdict: string | null;
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
const RECIPIENT_SELECT = 'id, email, status, mailbox_id, lead_verdict, lead_verdict_source, reply_language, sender_mailboxes(email)';
/** Письмо ИИ в «sending» дольше этого — считаем, что отправка оборвалась. */
const LETTER_STUCK_SENDING_MS = 60 * 60_000;
/** Письмо ИИ в очереди дольше этого — sender-хост не работает. */
const LETTER_STUCK_QUEUED_MS = 6 * 60 * 60_000;

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

/**
 * Короткие КП по продуктам папки (`sender_folders.ai_offer_texts`). Читаются отдельно
 * от общего запроса папок: до миграции каскада колонки нет, и общий запрос уронил бы
 * весь круг ИИ, в том числе английский автоаутрич. Любой сбой — пусто и предупреждение:
 * ход идёт с материалами продукта и общими необязательными указаниями.
 */
async function loadProductOfferTexts(db: SupabaseClient, folderId: string, log: Log): Promise<Record<string, unknown>> {
  try {
    const { data, error } = await db.from('sender_folders').select('ai_offer_texts').eq('id', folderId).maybeSingle();
    if (error) throw new Error(error.message);
    const texts = (data as { ai_offer_texts?: unknown } | null)?.ai_offer_texts;
    return texts && typeof texts === 'object' && !Array.isArray(texts) ? texts as Record<string, unknown> : {};
  } catch (err) {
    log('warn', `ИИ-квалификатор: уточнения по продуктам папки ${folderId} не прочитаны, используем согласованные материалы: ${errorText(err)}`);
    return {};
  }
}

/**
 * Материалы предложенного продукта подключаются автоматически. Ручные поля —
 * необязательные дополнения, они не заменяют условия и ограничения презентаций.
 * EN получает зарубежную классику и утверждённые английские кейсы. Сбой чтения
 * продукта получателя — исключение: ход повторится, а не уйдёт с КП не того продукта.
 */
export interface AiOfferContext extends Pick<AiPromptInput, 'offerText' | 'cascade' | 'productPitch'> {
  caseIds: string[];
}

async function recipientCaseContext(db: SupabaseClient, recipientId: string, folderKey: string): Promise<CaseMatchContext & { group: string | null }> {
  const { data, error } = await db.from('sender_recipients').select('group_key,sender_campaigns(source_kind)').eq('id', recipientId).maybeSingle();
  if (error) throw new Error(`case context recipient: ${error.message}`);
  const campaign = Array.isArray(data?.sender_campaigns) ? data.sender_campaigns[0] : data?.sender_campaigns;
  const expected = folderKey === 'auto_ru' ? 'polza_ru' : 'polza_en';
  const empty = { business: null, customers: null, group: null };
  if (!data || campaign?.source_kind !== expected || !/^[0-9a-f-]{36}$/i.test(data.group_key ?? '')) return empty;
  if (folderKey === 'auto_ru') {
    const { data: row, error: e } = await db.from('polza_ru_outreach_companies').select('fit_reasons,target_market,normalized_domain').eq('id', data.group_key).maybeSingle();
    if (e) throw new Error(`case context RU: ${e.message}`);
    const reasons: string[] = Array.isArray(row?.fit_reasons) ? row.fit_reasons.filter((r: unknown) => typeof r === 'string') : [];
    return { business: reasons.find((r) => r.startsWith('Продукт: '))?.slice(9) ?? null,
      customers: row?.target_market ?? null, group: reasons.find((r) => r.startsWith('Отрасль: '))?.slice(9) ?? null, key: row?.normalized_domain ?? '' };
  }
  const { data: row, error: e } = await db.from('polza_outreach_companies').select('company_context,normalized_domain').eq('id', data.group_key).maybeSingle();
  if (e) throw new Error(`case context EN: ${e.message}`);
  return { business: row?.company_context ?? null, group: null, key: row?.normalized_domain ?? '' };
}

export async function offerContextFor(
  db: SupabaseClient,
  folder: { id: string; key: string; ai_offer_text: string | null },
  recipientId: string,
  log: Log,
): Promise<AiOfferContext> {
  const general = folder.ai_offer_text ?? '';
  const context = await recipientCaseContext(db, recipientId, folder.key);
  if (folder.key !== 'auto_ru') {
    // Английские ответы используют ту же утверждённую библиотеку, что EN-письма,
    // с проверкой продукта. Не подменяем зарубежный результат русским переводом.
    const [english, productCases] = await Promise.all([loadEnCases(db), loadCases(db)]);
    const allowed = new Set(productCases.filter((c) => caseAllowedForProduct(c, 'classic_abroad')).map((c) => c.case_id));
    const cases = rankCaseMatches(english.filter((c) => allowed.has(c.caseId)).map((c) => ({ ...c, id: c.caseId, text: c.snippet })), context.group, context, 2).map((c) => c.record);
    return {
      offerText: [productKnowledgeText('classic_abroad', 'en'), general ? `ADDITIONAL NOTES (do not override product boundaries above):\n${general}` : '', cases.length ? 'APPROVED CASES (choose at most one matching the recipient\'s business and market):' : '',
        ...cases.map((c) => `[case_id=${c.caseId}; segments=${c.groups.join(',')}] ${c.snippet}${c.url ? ` Source: ${c.url}` : ''}`)].filter(Boolean).join('\n'),
      caseIds: cases.map((c) => c.caseId), cascade: false, productPitch: null,
    };
  }
  const offered = await loadRecipientProduct(db, recipientId, { includeLegacy: true });
  if (!offered) return {
    offerText: ['Продукт получателя не установлен: не выбирай его по догадке, не называй тарифы и гарантии. Если без этого нельзя ответить по существу — outcome=review.', general].filter(Boolean).join('\n'),
    cascade: true, productPitch: null, caseIds: [],
  };
  const own = (await loadProductOfferTexts(db, folder.id, log))[offered.product];
  const text = typeof own === 'string' ? own.trim() : '';
  const cases = (await loadCases(db)).filter((c) => caseAllowedForProduct(c, offered.product))
    .sort((a, b) => Number(b.cold_email !== false) - Number(a.cold_email !== false));
  const selected = offered.product === 'sdr' ? cases.slice(0, 3)
    : rankCaseMatches(cases.map((c) => ({ ...c, id: c.case_id, groups: c.industry_groups, text: c.case_text_short, profiles: c.match_profiles })), context.group, context, 2).map((c) => c.record);
  const proof = selected.length ? [
    'ПРОВЕРЕННЫЕ КЕЙСЫ ЭТОГО ПРОДУКТА:',
    ...selected.map((c) => `- [case_id=${c.case_id}; отрасли=${c.industry_groups.join(',')}] ${c.case_text_short.trim()}${c.case_url ? ` Источник: ${c.case_url}` : ''}`),
    'По вопросу клиента выбери максимум один подходящий пример и передай его в 1–2 предложениях. Не повторяй уже приведённый пример без необходимости. Сохрани роль и фактический исход: запрос подробностей не равен встрече, встреча не равна продаже; отказ и отложенный контакт не выдавай за успех. Не обещай повторить цифры у клиента. Доказательства выхода на роль получены в клиентских кампаниях Polza; отдельный канал этих кампаний не приписывай ручной SDR-услуге.',
  ].join('\n') : '';
  const notes = [general, text].filter(Boolean).join('\n');
  return {
    offerText: [productKnowledgeText(offered.product), notes ? `ДОПОЛНЕНИЯ (не отменяют границы продукта выше):\n${notes}` : '', proof].filter(Boolean).join('\n\n'),
    cascade: true, productPitch: productPitchOf(offered.product), caseIds: selected.map((c) => c.case_id),
  };
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
    .select(RECIPIENT_SELECT)
    .eq('id', recipientId).maybeSingle();
  if (error) throw new Error(`sender_recipients: ${error.message}`);
  return (data as unknown as RecipientRow | null) ?? null;
}

/** Переписка для модели и для цитаты в письме: наши письма, письма лида и ответы с портала. */
export async function loadConversationHistory(db: SupabaseClient, recipientId: string): Promise<AiPromptInput['history']> {
  const [messages, replies, manual] = await Promise.all([
    db.from('sender_messages').select('body, sent_at').eq('recipient_id', recipientId).eq('status', 'sent').order('sent_at', { ascending: false }).limit(50),
    db.from('sender_replies').select('body, received_at, created_at').eq('recipient_id', recipientId).eq('kind', 'human').order('created_at', { ascending: false }).limit(50),
    db.from('sender_manual_messages').select('body, sent_at').eq('recipient_id', recipientId).eq('status', 'sent').order('sent_at', { ascending: false }).limit(50),
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

/** Новые ответы, включая возражения, без переименования отказа в лид. */
async function startConversations(
  db: SupabaseClient, folders: Map<string, FolderRow>, campaignFolder: Map<string, string>,
): Promise<number> {
  const campaignIds = [...campaignFolder.entries()]
    .filter(([, folderId]) => folders.get(folderId)?.ai_enabled)
    .map(([campaignId]) => campaignId);
  if (!campaignIds.length) return 0;

  const { data, error } = await db.from('sender_ai_intake_queue')
    .select('reply_id, recipient_id, campaign_id, qualified_at')
    .in('campaign_id', campaignIds)
    .order('qualified_at').limit(BATCH);
  if (error) throw new Error(`sender_ai_intake_queue (проверьте миграцию возражений): ${error.message}`);

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
    const openDeal = await hasOpenAmoDeal(db, r.from_email || recipient.email);

    const { error: insertError } = await db.from('sender_ai_conversations').upsert({
      recipient_id: row.recipient_id,
      campaign_id: row.campaign_id,
      folder_key: folder.key,
      trigger_reply_id: row.reply_id,
      state: openDeal ? 'stopped' : 'active',
      last_error: openDeal ? 'Уже есть открытая сделка AMO, диалог ведёт менеджер' : null,
      next_action_at: openDeal ? null : replyDueAt(replyAt(r), windowOf(folder)).toISOString(),
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
    ai_reply_id: input.replyTo.id,
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
  recipient: RecipientRow;
  ccEmails: string[];
  newest: ReplyRow | null;
  result: AiPassResult;
  log: Log;
}

/** Сохраняем wire-формат: повтор проходит тот же строгий разбор, что ответ модели. */
function modelJsonOf(step: AiStep): Record<string, unknown> {
  const a = step.assessment;
  return {
    relevant: step.relevant, contact: step.contact, outcome: step.outcome,
    reply: step.reply, summary: step.summary, stop_requested: step.stopRequested,
    ...(a ? { assessment: { ...a, case_id: a.caseId } } : {}),
  };
}

async function savedStep(
  db: SupabaseClient, conv: AiConversationRow, replyId: string, mode: AiPromptInput['mode'],
  generate: () => Promise<AiStep>,
): Promise<{ id: string; step: AiStep }> {
  const id = letterId(conv, replyId);
  const read = async () => {
    const { data, error } = await db.from('sender_ai_turns').select('step_json').eq('id', id).maybeSingle();
    if (error) throw new Error(`sender_ai_turns: ${error.message}`);
    return data;
  };
  let row = await read();
  if (!row) {
    const generated = await generate();
    const { error } = await db.from('sender_ai_turns').upsert({
      id, recipient_id: conv.recipient_id, reply_id: replyId, mode,
      step_json: modelJsonOf(generated), decision: 'pending',
    }, { onConflict: 'id', ignoreDuplicates: true });
    if (error) throw new Error(`sender_ai_turns insert: ${error.message}`);
    row = await read();
  }
  if (!row) throw new Error('Ход ИИ не сохранился');
  const step = parseAiStep(JSON.stringify(row.step_json));
  if (step.assessment?.intent === 'stop') step.stopRequested = true;
  return { id, step };
}

/** Один ход разговора; если делать пока нечего — только переносит срок. */
async function stepConversation(db: SupabaseClient, conv: AiConversationRow, ctx: StepContext): Promise<void> {
  const { folder, newest, recipient, log } = ctx;
  const now = new Date();
  // Коллега может ответить со своей основной почты прямо в CC, вне портала.
  // Это не новая реплика покупателя (такое встречалось в архиве ENagency).
  const ourAddresses = new Set([recipient.sender_mailboxes?.email ?? '', ...ctx.ccEmails].map((e) => e.trim().toLowerCase()));
  if (newest?.from_email && ourAddresses.has(newest.from_email.trim().toLowerCase())) {
    await finish(db, conv, 'stopped', 'В переписку включился наш коллега со своей почты');
    await releaseToManagers(db, conv);
    return;
  }
  const planNext = async (due: Date) => {
    if (!conv.next_action_at || Date.parse(conv.next_action_at) !== due.getTime()) {
      await patchConversation(db, conv.recipient_id, { next_action_at: due.toISOString() });
    }
  };

  const hasNew = Boolean(newest && newest.id !== conv.last_reply_id);
  let mode: AiPromptInput['mode'];
  let due: Date;
  if (hasNew) {
    mode = 'reply';
    due = replyDueAt(replyAt(newest!), windowOf(folder));
  } else if (conv.last_ai_sent_at) {
    due = reminderDueAt(new Date(conv.last_ai_sent_at), folder.timezone);
    // После возражения молчание не является приглашением продолжать давление.
    if (conv.reminder_sent || conv.ai_messages >= MAX_AI_LETTERS
      || conv.last_intent === 'objection' || conv.last_intent === 'soft_decline') {
      if (now >= due) await finish(db, conv, 'no_reply', null);
      else await planNext(due);
      return;
    }
    mode = 'reminder';
  } else {
    await finish(db, conv, 'stopped', 'письмо лида не найдено');
    return;
  }

  if (now < due) {
    await planNext(due);
    return;
  }
  if (!isWithinWindow(now, windowOf(folder))) {
    await planNext(nextWindowSlot(now, windowOf(folder)));
    return;
  }

  // Новое письмо ждёт оценки квалификатора: стоп-слова и отписку он видит раньше нас.
  if (hasNew) {
    const { data: q, error } = await db.from('sender_reply_qualifications').select('status').eq('reply_id', newest!.id).maybeSingle();
    if (error) throw new Error(`sender_reply_qualifications: ${error.message}`);
    if (!q || !['lead', 'not_lead'].includes(q.status)) return;
  }
  if (!newest) {
    await finish(db, conv, 'stopped', 'письмо лида не найдено');
    return;
  }

  const cfg = aiQualifierConfig();
  if (!cfg) throw new Error('Ключ ИИ не настроен (SENDER_AI_QUALIFIER_API_KEY / SENDER_LEADS_AI_API_KEY)');
  const history = (await loadConversationHistory(db, conv.recipient_id))
    .filter((m) => m.from !== 'lead' || Date.parse(m.at ?? '') <= replyAt(newest).getTime());
  const ownMailbox = recipient.sender_mailboxes?.email?.toLowerCase() ?? '';
  const leadAddress = (newest.from_email || recipient.email).toLowerCase();
  const cc = ctx.ccEmails.filter((e) => e.toLowerCase() !== ownMailbox && e.toLowerCase() !== leadAddress);
  const language = recipient.reply_language === 'en' || recipient.reply_language === 'ru'
    ? recipient.reply_language
    : (conv.folder_key === 'auto_en' ? 'en' : 'ru');

  const offer = await offerContextFor(db, folder, conv.recipient_id, log);
  const memory = {
    turns: conv.objection_turns ?? 0, lastIntent: conv.last_intent ?? null,
    lastObjection: conv.last_objection ?? null, usedCaseIds: conv.used_case_ids ?? [],
  };
  const { id: turnId, step } = await savedStep(db, conv, newest.id, mode, () => requestAiStep(cfg, {
    language, mode, history, aiMessages: conv.ai_messages,
    ...offer, ccEmail: cc[0] ?? null, objections: memory,
  }));
  const decision = decideStep(step, {
    aiMessages: conv.ai_messages, stopRequested: step.stopRequested,
    objections: {
      ...memory, lastLeadText: stripQuoted(newest.body ?? '') || (newest.body ?? '').trim(), caseIds: offer.caseIds,
    },
  });
  const { error: turnError } = await db.from('sender_ai_turns').update({ decision: decision.kind }).eq('id', turnId);
  if (turnError) throw new Error(`sender_ai_turns decision: ${turnError.message}`);
  const a = step.assessment;
  const sends = 'letter' in decision && Boolean(decision.letter);
  const processed = {
    last_reply_id: newest.id, attempts: 0,
    last_intent: a?.intent ?? null, last_objection: a?.objection ?? null,
    objection_turns: memory.turns + (sends && (a?.intent === 'objection' || a?.intent === 'soft_decline') ? 1 : 0),
    used_case_ids: sends && a?.caseId ? [...new Set([...memory.usedCaseIds, a.caseId])] : memory.usedCaseIds,
  };

  if (decision.kind === 'review') {
    await patchConversation(db, conv.recipient_id, {
      ...processed, state: 'review', next_action_at: null, last_error: null,
      summary: decision.reason.slice(0, 2000),
    });
    return;
  }

  if (decision.kind === 'no_reply') {
    // Лимит писем исчерпан, а лид ответил: его новое письмо уходит менеджерам
    // прежним путём (deliverLeads не глушит лидов вне активного разговора).
    await patchConversation(db, conv.recipient_id, { ...processed, state: 'no_reply', next_action_at: null, last_error: null });
    return;
  }
  if (decision.kind === 'close') {
    if (decision.letter) {
      await enqueueAiLetter(db, { conv, recipient, replyTo: newest, text: decision.letter, cc: [], history });
      ctx.result.letters += 1;
    }
    // Просьба не писать, которую понял ИИ, — тот же отказ, что стоп-слово в repliesWorker:
    // адрес в общий стоп-лист, письма в очереди отменены, получатель отписан. До закрытия
    // разговора и по шагам: любой сбой — ход сбойный и повторится, разговор остаётся открытым.
    // Статус получателя ставится последним: по нему повтор (CLOSED_RECIPIENT) считает дело
    // сделанным, значит, стоп-лист и очередь к этому моменту уже записаны.
    if (step.stopRequested) {
      const failed = await suppressEmails(db, [leadAddress, recipient.email], 'ИИ: просьба не писать')
        ?? await cancelPendingMessages(db, conv.recipient_id)
        ?? await markUnsubscribed(db, conv.recipient_id);
      if (failed) throw new Error(`стоп-лист: ${failed}`);
    }
    await patchConversation(db, conv.recipient_id, {
      ...processed, state: 'closed', close_reason: closeReasonOf(step), summary: step.summary || null,
      next_action_at: null, last_error: null,
      ai_messages: conv.ai_messages + (decision.letter ? 1 : 0),
    });
    ctx.result.closed += 1;
    return;
  }
  if (decision.kind === 'handoff') {
    // Сначала строка лида для чата и AMO (повтор безопасен), потом письмо, потом
    // состояние: если шаг сорвётся, менеджеры всё равно не потеряют лида.
    const reason = `Передал ИИ. Контакт: ${decision.contact}.${decision.summary ? ` ${decision.summary}` : ''}`;
    const { error } = await db.from('sender_reply_qualifications')
      .update({ status: 'lead', ai_reason: reason.slice(0, 2000), tg_attempts: 0, tg_error: null, updated_at: now.toISOString() })
      .eq('reply_id', newest.id);
    if (error) throw new Error(`sender_reply_qualifications: ${error.message}`);
    if (decision.letter) await enqueueAiLetter(db, { conv, recipient, replyTo: newest, text: decision.letter, cc, history });
    await patchConversation(db, conv.recipient_id, {
      ...processed, state: 'handed_off', handoff_reply_id: newest.id, handoff_contact: decision.contact,
      summary: decision.summary || null, ai_messages: conv.ai_messages + (decision.letter ? 1 : 0),
      last_ai_sent_at: decision.letter ? now.toISOString() : conv.last_ai_sent_at,
      next_action_at: null, last_error: null,
    });
    if (decision.letter) ctx.result.letters += 1;
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
      const newer = !prev || replyAt(r).getTime() > replyAt(prev).getTime()
        || (replyAt(r).getTime() === replyAt(prev).getTime()
          && (r.created_at > prev.created_at || (r.created_at === prev.created_at && r.id > prev.id)));
      if (newer) out.set(r.recipient_id, r);
    }
  }
  return out;
}

interface AiLetterRow {
  recipient_id: string;
  status: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Состояние для всех активных разговоров одним набором запросов: получатели,
 * ответы оператора и последнее письмо ИИ. Стоп-условия проверяются каждый
 * круг, а не только когда настал срок хода.
 */
async function loadActiveContext(db: SupabaseClient, ids: string[]): Promise<{
  recipients: Map<string, RecipientRow>; operator: Set<string>; letters: Map<string, AiLetterRow>;
}> {
  const recipients = new Map<string, RecipientRow>();
  const operator = new Set<string>();
  const letters = new Map<string, AiLetterRow>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const [r, o, l] = await Promise.all([
      db.from('sender_recipients').select(RECIPIENT_SELECT).in('id', chunk),
      db.from('sender_manual_messages').select('recipient_id')
        .in('recipient_id', chunk).is('agency_handoff_id', null).is('handoff', null).eq('by_ai', false),
      db.from('sender_manual_messages').select('recipient_id, status, error, created_at, updated_at')
        .in('recipient_id', chunk).eq('by_ai', true),
    ]);
    for (const res of [r, o, l]) if (res.error) throw new Error(`состояние разговоров: ${res.error.message}`);
    for (const row of (r.data ?? []) as unknown as RecipientRow[]) recipients.set(row.id, row);
    for (const row of (o.data ?? []) as Array<{ recipient_id: string }>) operator.add(row.recipient_id);
    for (const row of (l.data ?? []) as AiLetterRow[]) {
      const prev = letters.get(row.recipient_id);
      if (!prev || Date.parse(row.created_at) > Date.parse(prev.created_at)) letters.set(row.recipient_id, row);
    }
  }
  return { recipients, operator, letters };
}

/** Письмо ИИ не ушло (ящик, SMTP) или зависло: разговор продолжать бессмысленно. */
function letterProblem(letter: AiLetterRow | undefined, now: number): string | null {
  if (!letter) return null;
  if (letter.status === 'failed' && !letter.error?.startsWith(AI_LETTER_CANCELLED)) return `письмо ИИ не ушло: ${letter.error ?? 'ошибка отправки'}`;
  if (letter.status === 'sending' && now - Date.parse(letter.updated_at) > LETTER_STUCK_SENDING_MS) return 'письмо ИИ зависло в отправке';
  if (letter.status === 'queued' && now - Date.parse(letter.created_at) > LETTER_STUCK_QUEUED_MS) return 'письмо ИИ давно ждёт отправки';
  return null;
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

  const ids = active.map((c) => c.recipient_id);
  const [newest, context, handoff] = await Promise.all([
    newestReplies(db, ids), loadActiveContext(db, ids), loadHandoffSettings(db),
  ]);
  const now = Date.now();
  for (const conv of active) {
    try {
      const folder = folders.get(campaignFolder.get(conv.campaign_id) ?? '');
      const recipient = context.recipients.get(conv.recipient_id);
      if (!folder?.ai_enabled) {
        // ИИ выключили посреди разговора — лид уходит менеджерам как раньше.
        await finish(db, conv, 'failed', 'ИИ выключен в настройках папки');
        await releaseToManagers(db, conv);
        continue;
      }
      const closed = !recipient || CLOSED_RECIPIENT.includes(recipient.status);
      const manualNotLead = recipient?.lead_verdict_source === 'manual' && recipient.lead_verdict === 'not_lead';
      if (!recipient || closed || recipient.lead_verdict_source === 'manual' || context.operator.has(conv.recipient_id)) {
        await finish(db, conv, 'stopped', 'переписка остановлена, отмечена вручную или ответил оператор');
        // Человек взял лида сам (ответил или поставил «лид») — лид должен дойти
        // до чата и AMO, как раньше. Отписку и «не лид» менеджерам не отдаём.
        if (!closed && !manualNotLead) await releaseToManagers(db, conv);
        continue;
      }
      const problem = letterProblem(context.letters.get(conv.recipient_id), now);
      if (problem) {
        await finish(db, conv, 'failed', problem);
        await releaseToManagers(db, conv);
        log('warn', `ИИ-квалификатор: ${conv.recipient_id} передан менеджерам — ${problem}`);
        continue;
      }
      // Пауза после сбоя: следующий ход не раньше назначенного времени.
      if (conv.attempts > 0 && conv.next_action_at && Date.parse(conv.next_action_at) > now) continue;
      const ccEmails = handoff.find((s) => s.scope === conv.folder_key)?.cc_emails ?? [];
      await stepConversation(db, conv, { folder, recipient, ccEmails, newest: newest.get(conv.recipient_id) ?? null, result, log });
    } catch (err) {
      await recordFailure(db, conv, err, log);
    }
  }
  return result;
}

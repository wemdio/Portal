import type { SupabaseClient } from '@supabase/supabase-js';
import { buildHandoffDraft } from '@/lib/instantly/handoffLegend';
import { getBoardLinkForProject, getOrCreateBoard, upsertBoardRow } from '@/lib/instantly/leadBoardWriter';
import { leadBoardRequestText } from '@/lib/instantly/leadBoardRequestText';
import { joinLeadPhones } from '@/lib/instantly/leadContactValues';
import { extractLeadReplyContacts } from '@/lib/instantly/leadReplyContacts';
import { INTERNAL_ROLES } from '@/lib/roles';
import {
  enqueueSenderHandoff,
  HandoffAlreadyQueuedError,
  loadSenderHandoffContext,
  type SenderHandoffContext,
} from '@/lib/sender/clientHandoff';
import type { Log } from './process';
import {
  editSenderProjectLeadCard,
  postSenderProjectLeadCard,
  signSenderLeadAction,
  type InlineKeyboard,
  type SenderLeadCardPost,
} from './projectLeadTelegram';
import { threadUrl } from './telegram';

/**
 * Лиды кампаний Движка вертикалей в «Рассылке» — как лиды Instantly (этап 5):
 * карточка специалисту проекта в чат лид-алертов, строка на доске лидов
 * проекта, передача клиенту письмом «Рассылки» с клиентом в копии.
 *
 * Один круг воркера worker-sender-leads:
 * 1. новые лиды → карточки (одна на переписку); ещё один ответ-лид уже
 *    доставленной переписки дописывается в её строку доски;
 * 2. недоставленные карточки → доставка: доска, уведомление, Telegram;
 * 3. события → следующий шаг: письмо передачи ушло или не ушло, «Не лид» из
 *    «Рассылки», текст карточки отстал от статуса.
 *
 * Режим как у Instantly: передача настроена (почта, легенда, ответственный,
 * LEAD_HANDOFF_ENABLED) — manual (кнопки) или auto (письмо уходит само);
 * не настроена — none (лид сразу на доске, «Не лид» на карточке). Режим и
 * ответственный фиксируются на первой попытке.
 *
 * До передачи (manual, auto) строка доски скрыта и открывается, когда письмо
 * передачи ушло. Сбои доставки повторяются по лесенке до 7 суток.
 */

const CARD_BATCH = 10;
const EVENT_BATCH = 50;
const RETRY_DELAYS_MIN = [1, 5, 15, 60];
const DELIVERY_WINDOW_MS = 7 * 24 * 60 * 60_000;
const TG_LIMIT = 4096;
/** Самая длинная строка статуса — копия и ошибка по 300 символов с подписями. */
const STATUS_RESERVE = 800;
/** Срок для шага auto_retry, когда причина сама не пройдёт: больше не берётся. */
const NEVER = '9999-01-01T00:00:00.000Z';
/** Пауза между попытками отложенной автопередачи. */
const AUTO_RETRY_MIN = 15;

type HandoffMode = 'manual' | 'auto' | 'none';
export type CardStatus = 'pending' | 'card_sent' | 'queued' | 'sent' | 'rejected' | 'handoff_failed' | 'undelivered';

export interface ProjectLeadCardRow {
  recipient_id: string;
  reply_id: string;
  campaign_id: string;
  project_id: string;
  responsible_user_id: string | null;
  handoff_mode: HandoffMode | null;
  status: CardStatus;
  draft_text: string | null;
  blocked_reason: string | null;
  manual_message_id: string | null;
  tg_chat_id: string | null;
  tg_message_id: number | null;
  tg_html: string | null;
  tg_keyboard: InlineKeyboard | null;
  tg_rendered_status: string | null;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  merged_reply_ids: string[];
  board_written_at: string | null;
  board_published_at: string | null;
  decided_by_user_id: string | null;
  decided_by_telegram_id: number | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

export const CARD_SELECT = 'recipient_id, reply_id, campaign_id, project_id, responsible_user_id, handoff_mode, status, draft_text, blocked_reason, manual_message_id, tg_chat_id, tg_message_id, tg_html, tg_keyboard, tg_rendered_status, attempts, next_attempt_at, last_error, merged_reply_ids, board_written_at, board_published_at, decided_by_user_id, decided_by_telegram_id, decided_at, created_at, updated_at';

export interface ProjectLeadCardDeps {
  /** Основная база: «Рассылка», проекты, профили, уведомления. */
  db: SupabaseClient;
  /** База Instantly: доска лидов. Без неё карточки ждут. */
  instantlyDb: SupabaseClient | null;
  log: Log;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  post?: (card: SenderLeadCardPost) => Promise<number>;
  edit?: typeof editSenderProjectLeadCard;
  draft?: typeof buildHandoffDraft;
}

interface ProjectRow {
  id: string;
  client: string | null;
  specialist_user_id: string | null;
  specialist: string | null;
  manager: string | null;
  handoff_email: string | null;
  handoff_legend: string | null;
  handoff_auto_send: boolean | null;
  handoff_ai_adapt: boolean | null;
  tag_project_lead_in_telegram: boolean | null;
}

interface ReplyRow {
  id: string;
  from_email: string | null;
  from_name: string | null;
  subject: string | null;
  body: string | null;
  message_id: string | null;
  received_at: string | null;
  created_at: string;
}

const PROJECT_SELECT = 'id, client, specialist_user_id, specialist, manager, handoff_email, handoff_legend, handoff_auto_send, handoff_ai_adapt, tag_project_lead_in_telegram';

/** Причина «передать нельзя», которая сама не пройдёт: кнопку «Передать» не показываем. */
const PERMANENT_BLOCKS = [
  'Кампания не привязана к проекту',
  'У проекта не указана почта для передачи',
  'Лид уже передан клиенту',
  'Адресат отписался или адрес в отбое',
  'Адрес в стоп-листе',
];

export function isPermanentHandoffBlock(reason: string | null | undefined): boolean {
  return Boolean(reason) && PERMANENT_BLOCKS.some((prefix) => reason!.startsWith(prefix));
}

export function handoffEnabled(env: NodeJS.ProcessEnv): boolean {
  return /^(1|true|yes)$/i.test((env.LEAD_HANDOFF_ENABLED ?? '').trim());
}

/** Бот, чат и тема лид-алертов — те же, что видит воркер лидов Instantly (тема без запасной CHANGELOG). */
export function leadAlertsTelegram(env: NodeJS.ProcessEnv): { token: string; chatId: string; threadId: number | null } | null {
  const token = env.LEAD_ALERTS_TELEGRAM_BOT_TOKEN || env.CHANGELOG_BOT_TOKEN || '';
  const chatId = env.LEAD_ALERTS_TELEGRAM_CHAT_ID || env.CHANGELOG_CHAT_ID || '';
  const thread = Number(env.LEAD_ALERTS_TELEGRAM_THREAD_ID ?? '');
  if (!token || !chatId) return null;
  return { token, chatId, threadId: Number.isFinite(thread) && thread > 0 ? thread : null };
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Обрезать сырой текст, а не готовый HTML: сущность не разорвётся. */
function clip(text: string, limit: number): string {
  if (limit <= 0) return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).replace(/[\uD800-\uDBFF]$/, '')}…`;
}

function visibleLength(html: string): number {
  return html.replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot);/g, '_').length;
}

function retryAt(now: Date, attempts: number): string {
  const minutes = RETRY_DELAYS_MIN[Math.min(Math.max(attempts, 1) - 1, RETRY_DELAYS_MIN.length - 1)];
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

export async function markNotificationsRead(db: SupabaseClient, replyId: string, log: Log): Promise<void> {
  // Решение принято — эскалация руководителю и CEO по этому лиду не нужна.
  const { error } = await db.from('notifications').update({ is_read: true })
    .eq('type', 'lead_new').eq('entity_type', 'lead_qualification').eq('entity_id', replyId);
  if (error) log('warn', `Лид ${replyId}: уведомление не отмечено прочитанным: ${error.message}`);
}

// ─── Люди проекта ──────────────────────────────────────────────────────────

interface ProjectPeople {
  /** Ответственный: specialist_user_id, иначе единственный сотрудник с ФИО «Специалиста». */
  responsibleUserId: string | null;
  /** Лид проекта (PM) для отметки, если проект просит. */
  pmUserId: string | null;
}

async function resolveProjectPeople(db: SupabaseClient, project: ProjectRow): Promise<ProjectPeople> {
  let responsibleUserId = project.specialist_user_id;
  if (!responsibleUserId && project.specialist?.trim()) {
    const name = project.specialist.trim();
    const { data, error } = await db.from('profiles').select('id, full_name').in('role', INTERNAL_ROLES).eq('full_name', name);
    if (error) throw new Error(`profiles: ${error.message}`);
    const exact = ((data ?? []) as Array<{ id: string; full_name: string }>).filter((row) => row.full_name === name);
    if (exact.length === 1) responsibleUserId = exact[0].id;
  }
  let pmUserId: string | null = null;
  const managerName = project.tag_project_lead_in_telegram ? project.manager?.trim() ?? '' : '';
  if (managerName) {
    const { data, error } = await db.from('profiles').select('id, full_name').in('role', INTERNAL_ROLES).ilike('full_name', managerName);
    if (error) throw new Error(`profiles: ${error.message}`);
    const exact = ((data ?? []) as Array<{ id: string; full_name: string | null }>)
      .filter((row) => row.full_name?.trim().toLocaleLowerCase('ru-RU') === managerName.toLocaleLowerCase('ru-RU'));
    if (exact.length === 1 && exact[0].id !== responsibleUserId) pmUserId = exact[0].id;
  }
  return { responsibleUserId, pmUserId };
}

/** Упоминание: по telegram_id (пингует надёжно), иначе @username, иначе имя. */
async function mentions(db: SupabaseClient, userIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return out;
  const [{ data: profiles }, { data: links }] = await Promise.all([
    db.from('profiles').select('id, full_name, email').in('id', ids),
    db.from('telegram_links').select('user_id, telegram_id, telegram_username').in('user_id', ids),
  ]);
  const profileById = new Map(((profiles ?? []) as Array<{ id: string; full_name: string | null; email: string | null }>).map((row) => [row.id, row]));
  const linkById = new Map(((links ?? []) as Array<{ user_id: string; telegram_id: number | string | null; telegram_username: string | null }>).map((row) => [row.user_id, row]));
  for (const id of ids) {
    const profile = profileById.get(id);
    const link = linkById.get(id);
    const username = link?.telegram_username?.trim().replace(/^@+/, '') || null;
    const name = clip(profile?.full_name?.trim() || username || profile?.email || 'Специалист', 120);
    if (link?.telegram_id) out.set(id, `<a href="tg://user?id=${escapeHtml(String(link.telegram_id))}">${escapeHtml(name)}</a>`);
    else if (username) out.set(id, `@${escapeHtml(clip(username, 64))}`);
    else out.set(id, escapeHtml(name));
  }
  return out;
}

// ─── Текст карточки ────────────────────────────────────────────────────────

export interface CardText {
  mode: HandoffMode;
  responsible: string | null;
  pm: string | null;
  contact: string;
  companyName: string | null;
  phone: string | null;
  website: string | null;
  clientName: string | null;
  campaignName: string | null;
  replySubject: string | null;
  replyText: string;
  aiReason: string | null;
  draft: string | null;
  cc: string[];
  blockedReason: string | null;
  boardLink: string | null;
  replyId: string;
}

export function buildProjectLeadCardHtml(card: CardText): string {
  const lines = [
    '<b>Новый лид из «Рассылки»</b>',
    '',
    `<b>Ответственный:</b> ${card.responsible ?? 'ответственный специалист не найден'}`,
  ];
  if (card.pm) lines.push(`<b>Лид проекта:</b> ${card.pm}`);
  lines.push(`<b>Контакт:</b> ${escapeHtml(clip(card.contact, 400))}`);
  if (card.companyName) lines.push(`<b>Компания:</b> ${escapeHtml(clip(card.companyName, 200))}`);
  if (card.phone) lines.push(`<b>Телефон:</b> ${escapeHtml(clip(card.phone, 200))}`);
  if (card.website) lines.push(`<b>Сайт:</b> ${escapeHtml(clip(card.website, 300))}`);
  if (card.clientName) lines.push(`<b>Клиент Portal:</b> ${escapeHtml(clip(card.clientName, 200))}`);
  if (card.campaignName) lines.push(`<b>Кампания:</b> ${escapeHtml(clip(card.campaignName, 300))}`);
  if (card.replySubject) lines.push(`<b>Тема:</b> ${escapeHtml(clip(card.replySubject, 300))}`);

  const tail: string[] = [];
  const permanent = isPermanentHandoffBlock(card.blockedReason);
  if (card.mode === 'manual') {
    if (permanent) {
      tail.push('', `⚠️ <b>Передать нельзя:</b> ${escapeHtml(clip(card.blockedReason!, 300))}`, '«Не лид» — лид не попадёт в таблицу клиента.');
    } else {
      tail.push('', '<b>Уйдёт лиду:</b>', `<pre>${escapeHtml(clip(card.draft ?? '', 1000))}</pre>`);
      tail.push(`<b>Клиент в копию:</b> ${escapeHtml(clip(card.cc.join(', ') || '—', 300))}`);
      if (card.blockedReason) tail.push(`⏳ Сейчас передать нельзя: ${escapeHtml(clip(card.blockedReason, 300))}. Кнопка проверит снова.`);
      tail.push('', '⚠️ В таблице клиента лид появится после передачи. «Передать клиенту» — письмо уйдёт из «Рассылки», клиент в копии. «Не лид» — лид не попадёт в таблицу.');
    }
  } else if (card.mode === 'auto') {
    tail.push('', '⚡ Автопередача включена — письмо передачи уйдёт из «Рассылки» само, клиент в копии.');
    if (permanent) tail.push(`⚠️ Передать нельзя: ${escapeHtml(clip(card.blockedReason!, 300))}`);
    else if (card.blockedReason) {
      tail.push(`⏳ Автопередача отложена: ${escapeHtml(clip(card.blockedReason, 300))}. Повторим автоматически; передать можно и из «Писем» «Рассылки».`);
    }
  } else {
    tail.push('', 'Передача клиенту для проекта не настроена (почта, легенда и ответственный в карточке проекта) — лид сразу в таблице клиента.');
  }
  if (card.boardLink) tail.push('', `📋 <a href="${escapeHtml(card.boardLink)}">Все лиды проекта</a>`);
  tail.push('', `<code>${escapeHtml(card.replyId)}</code>`);

  // Запас под строку статуса, которую допишет правка карточки (cardStatusLine).
  const remaining = () => Math.max(0, TG_LIMIT - STATUS_RESERVE - visibleLength([...lines, ...tail].join('\n')));
  const reason = card.aiReason ? clip(card.aiReason, Math.min(700, Math.max(0, remaining() - 10))) : '';
  const replyBudget = Math.min(1200, Math.max(0, remaining() - (reason ? reason.length + 10 : 0) - 20));
  if (card.replyText && replyBudget > 0) lines.push('', '<b>Ответ:</b>', `<pre>${escapeHtml(clip(card.replyText, replyBudget))}</pre>`);
  if (reason) lines.push('', `<b>AI:</b> ${escapeHtml(reason)}`);
  return [...lines, ...tail].join('\n');
}

/** Кнопки решения карточки и ссылка на переписку. */
export function projectLeadKeyboard(opts: {
  mode: HandoffMode;
  recipientId: string;
  token: string;
  blockedReason: string | null;
  autoSendOn: boolean;
  hasResponsible: boolean;
  url: string | null;
}): InlineKeyboard {
  const rows: InlineKeyboard = [];
  const reject = { text: 'Не лид', callback_data: signSenderLeadAction('x', opts.recipientId, opts.token) };
  if (opts.mode === 'manual') {
    if (!isPermanentHandoffBlock(opts.blockedReason)) {
      rows.push([{ text: '➡️ Передать клиенту', callback_data: signSenderLeadAction('p', opts.recipientId, opts.token) }]);
    }
    rows.push([reject]);
  } else if (opts.mode === 'none' && !opts.autoSendOn && opts.hasResponsible) {
    rows.push([reject]);
  }
  if (opts.url) rows.push([{ text: 'Открыть переписку', url: opts.url }]);
  return rows;
}

function urlOnly(keyboard: InlineKeyboard | null): InlineKeyboard {
  return (keyboard ?? []).filter((row) => row.some((button) => 'url' in button));
}

/** Строка статуса под текстом карточки. */
export function cardStatusLine(
  card: Pick<ProjectLeadCardRow, 'status' | 'decided_by_telegram_id'> & Partial<Pick<ProjectLeadCardRow, 'handoff_mode' | 'blocked_reason' | 'next_attempt_at'>>,
  handoff: { error: string | null; cc: string[] | null },
): string | null {
  const cc = escapeHtml(clip((handoff.cc ?? []).join(', ') || '—', 300));
  switch (card.status) {
    case 'card_sent':
      // Автопередача сдалась — карточка больше не обещает повтор.
      if (card.handoff_mode === 'auto' && card.next_attempt_at && Date.parse(card.next_attempt_at) >= Date.parse(NEVER)) {
        return `⚠️ <b>Автопередача не состоится:</b> ${escapeHtml(clip(card.blocked_reason ?? 'причина не сохранена', 300))}. Передайте из «Рассылки» — «Открыть переписку».`;
      }
      return null;
    case 'queued':
      return `⏳ <b>Передача в очереди</b> — письмо уйдёт из «Рассылки», в копии: ${cc}`;
    case 'sent': {
      const partial = handoff.error?.startsWith('Ушло не всем') ? `\n⚠️ ${escapeHtml(clip(handoff.error, 300))}` : '';
      return `✅ <b>Передано клиенту</b> — в копии: ${cc}${partial}`;
    }
    case 'rejected':
      return card.decided_by_telegram_id ? '🚫 <b>Не лид</b>' : '🚫 <b>Не лид</b> (отмечено в «Рассылке»)';
    case 'handoff_failed':
      return `⚠️ <b>Письмо передачи не ушло:</b> ${escapeHtml(clip(handoff.error ?? 'причина не сохранена', 300))}. Передайте из «Рассылки» — «Открыть переписку».`;
    default:
      return null;
  }
}

// ─── Шаги ──────────────────────────────────────────────────────────────────

export async function loadCard(db: SupabaseClient, recipientId: string): Promise<ProjectLeadCardRow | null> {
  const { data, error } = await db.from('sender_project_lead_cards').select(CARD_SELECT).eq('recipient_id', recipientId).maybeSingle();
  if (error) throw new Error(`sender_project_lead_cards: ${error.message}`);
  return (data as ProjectLeadCardRow | null) ?? null;
}

async function loadReply(db: SupabaseClient, replyId: string): Promise<ReplyRow | null> {
  const { data, error } = await db.from('sender_replies')
    .select('id, from_email, from_name, subject, body, message_id, received_at, created_at').eq('id', replyId).maybeSingle();
  if (error) throw new Error(`sender_replies: ${error.message}`);
  return (data as ReplyRow | null) ?? null;
}

function replyPhone(body: string | null): string | null {
  if (!body) return null;
  try {
    const contacts = extractLeadReplyContacts({ text: body });
    return joinLeadPhones([contacts.bodyPhone, contacts.signaturePhone]);
  } catch {
    return null;
  }
}

/** Ещё один ответ-лид доставленной переписки — в её строку доски. */
async function mergeReply(deps: Required<Pick<ProjectLeadCardDeps, 'db' | 'log'>> & { instantlyDb: SupabaseClient | null }, recipientId: string, replyId: string): Promise<void> {
  const { db, instantlyDb } = deps;
  const card = await loadCard(db, recipientId);
  if (!card || !card.board_written_at || card.merged_reply_ids.includes(replyId)) return;
  if (!instantlyDb) throw new Error('база Instantly не настроена — доска лидов недоступна');
  const reply = await loadReply(db, replyId);
  if (reply) {
    const { data: campaign } = await db.from('sender_campaigns').select('name').eq('id', card.campaign_id).maybeSingle();
    await upsertBoardRow(instantlyDb, {
      qualificationId: card.recipient_id,
      sourceQualificationId: replyId,
      projectId: card.project_id,
      campaignId: card.campaign_id,
      campaignName: (campaign as { name?: string } | null)?.name ?? null,
      leadEmail: reply.from_email,
      leadName: null,
      companyName: null,
      phone: replyPhone(reply.body),
      website: null,
      requestText: leadBoardRequestText({ text: reply.body ?? '' }),
      stepNumber: null,
      replyTimestamp: reply.received_at ?? reply.created_at,
      source: 'sender',
    });
  }
  // Объединение, а не перезапись: параллельный круг мог дописать свой ответ.
  const { error } = await db.from('sender_project_lead_cards')
    .update({ merged_reply_ids: [...card.merged_reply_ids, replyId], updated_at: new Date().toISOString() })
    .eq('recipient_id', card.recipient_id).eq('updated_at', card.updated_at);
  if (error) throw new Error(`sender_project_lead_cards merge: ${error.message}`);
}

/** Существующая передача (не failed) по переписке. */
export async function activeHandoff(db: SupabaseClient, recipientId: string): Promise<{ id: string; status: string } | null> {
  const { data, error } = await db.from('sender_manual_messages').select('id, status')
    .eq('recipient_id', recipientId).not('handoff', 'is', null).neq('status', 'failed')
    .order('created_at', { ascending: false }).limit(1);
  if (error) throw new Error(`sender_manual_messages: ${error.message}`);
  return ((data ?? []) as Array<{ id: string; status: string }>)[0] ?? null;
}

/** Последнее письмо передачи по переписке, в любом статусе. */
async function latestHandoff(db: SupabaseClient, recipientId: string): Promise<{ id: string; status: string; error: string | null; cc_emails: string[] | null; created_at: string } | null> {
  const { data, error } = await db.from('sender_manual_messages').select('id, status, error, cc_emails, created_at')
    .eq('recipient_id', recipientId).not('handoff', 'is', null)
    .order('created_at', { ascending: false }).limit(1);
  if (error) throw new Error(`sender_manual_messages: ${error.message}`);
  return ((data ?? []) as Array<{ id: string; status: string; error: string | null; cc_emails: string[] | null; created_at: string }>)[0] ?? null;
}

/** Ответ, который процитирует передача, — один из ответов-лидов карточки (не более свежий). */
export async function handoffQuotesCardReply(db: SupabaseClient, card: Pick<ProjectLeadCardRow, 'reply_id' | 'merged_reply_ids'>, ctx: SenderHandoffContext): Promise<boolean> {
  if (!ctx.reply?.messageId) return false;
  const ids = [...new Set([card.reply_id, ...card.merged_reply_ids])];
  const { data, error } = await db.from('sender_replies').select('message_id').in('id', ids);
  if (error) throw new Error(`sender_replies: ${error.message}`);
  return ((data ?? []) as Array<{ message_id: string | null }>).some((row) => row.message_id === ctx.reply!.messageId);
}

/** Копия как в окне передачи «Рассылки»: не пустая, до 10 адресов, без лида. Причина — или null. */
export function handoffCcIssue(ctx: SenderHandoffContext): string | null {
  if (!ctx.cc.length) return 'Укажите почту клиента для копии';
  if (ctx.cc.length > 10) return 'В копии больше 10 адресов — передайте из «Писем» «Рассылки»';
  if (ctx.cc.some((email) => email.toLowerCase() === ctx.to.toLowerCase())) return 'Адрес лида стоит в копии — передайте из «Писем» «Рассылки»';
  return null;
}

class TransientCardError extends Error {}

/** Отказ Telegram по самому сообщению (удалено, нет прав, не разобрал) — повтор не поможет; сеть и «слишком часто» — поможет. */
function isFinalTelegramRefusal(message: string): boolean {
  return !/Too Many Requests|HTTP 5\d\d|fetch failed|timeout|aborted/i.test(message) && /Bad Request|Forbidden|not found/i.test(message);
}

async function deliverCard(deps: ProjectLeadCardDeps & { env: NodeJS.ProcessEnv; now: () => Date }, card: ProjectLeadCardRow): Promise<void> {
  const { db, instantlyDb, env, log } = deps;
  const now = deps.now();
  // Аренда: попытка засчитана до любых побочных действий — постоянная ошибка
  // после отправки не превратит карточку в рассылку раз в минуту.
  const attempts = card.attempts + 1;
  const { data: leased, error: leaseError } = await db.from('sender_project_lead_cards')
    .update({ attempts, next_attempt_at: retryAt(now, attempts), updated_at: now.toISOString() })
    .eq('recipient_id', card.recipient_id).eq('status', 'pending').eq('attempts', card.attempts)
    .select(CARD_SELECT).maybeSingle();
  if (leaseError) throw new Error(`sender_project_lead_cards lease: ${leaseError.message}`);
  if (!leased) return;
  const current = leased as ProjectLeadCardRow;

  const finish = async (patch: Record<string, unknown>) => {
    const { error } = await db.from('sender_project_lead_cards')
      .update({ ...patch, updated_at: deps.now().toISOString() }).eq('recipient_id', current.recipient_id);
    if (error) throw new Error(`sender_project_lead_cards: ${error.message}`);
  };
  const giveUp = async (reason: string) => {
    log('error', `Карточка лида ${current.reply_id} не доставлена: ${reason}`);
    await finish({ status: 'undelivered', last_error: reason.slice(0, 500), next_attempt_at: null });
  };

  try {
    if (now.getTime() - Date.parse(current.created_at) > DELIVERY_WINDOW_MS) {
      await giveUp(`за 7 суток не удалось: ${current.last_error ?? 'причина не сохранена'}`);
      return;
    }
    const tg = leadAlertsTelegram(env);
    if (!tg) throw new TransientCardError('бот лид-алертов не настроен (LEAD_ALERTS_TELEGRAM_BOT_TOKEN / _CHAT_ID)');
    if (!instantlyDb) throw new TransientCardError('база Instantly не настроена — доска лидов недоступна');

    const [{ data: recipient, error: recipientError }, { data: project, error: projectError }, { data: campaign, error: campaignError }, { data: qualification, error: qualificationError }] = await Promise.all([
      db.from('sender_recipients').select('id, lead_verdict, lead_verdict_source, last_step_sent').eq('id', current.recipient_id).maybeSingle(),
      db.from('projects').select(PROJECT_SELECT).eq('id', current.project_id).maybeSingle(),
      db.from('sender_campaigns').select('id, name').eq('id', current.campaign_id).maybeSingle(),
      db.from('sender_reply_qualifications').select('ai_reason').eq('reply_id', current.reply_id).maybeSingle(),
    ]);
    const readError = recipientError ?? projectError ?? campaignError ?? qualificationError;
    if (readError) throw new TransientCardError(`чтение: ${readError.message}`);
    if (!recipient || !project) {
      await giveUp(!recipient ? 'переписка удалена' : 'проект удалён');
      return;
    }
    const verdict = recipient as { lead_verdict: string | null; lead_verdict_source: string | null; last_step_sent: number | null };
    // Карточку снимает только человек: более поздний ответ «не лид» по оценке ИИ
    // («спасибо, получили») настоящего лида не отменяет.
    if (verdict.lead_verdict === 'not_lead' && verdict.lead_verdict_source === 'manual') {
      if (current.board_written_at) await setBoardReview(instantlyDb, current.recipient_id, true);
      await finish({ status: 'rejected', next_attempt_at: null, last_error: 'отмечено «Не лид» до карточки' });
      return;
    }
    const proj = project as ProjectRow;

    // Режим и ответственный — с первой попытки: смена настроек проекта
    // между попытками не откроет скрытую строку и не спрячет открытую.
    let mode = current.handoff_mode;
    let responsibleUserId = current.responsible_user_id;
    const people = await resolveProjectPeople(db, proj);
    if (!mode) {
      responsibleUserId = people.responsibleUserId;
      const configured = handoffEnabled(env) && Boolean(proj.specialist_user_id)
        && Boolean(proj.handoff_email?.trim()) && Boolean(proj.handoff_legend?.trim());
      mode = configured ? (proj.handoff_auto_send === true ? 'auto' : 'manual') : 'none';
      await finish({ handoff_mode: mode, responsible_user_id: responsibleUserId });
    }

    const ctx = await loadSenderHandoffContext(db, instantlyDb, current.recipient_id);
    if (!ctx) {
      await giveUp('переписка не найдена');
      return;
    }
    const reply = await loadReply(db, current.reply_id);
    if (!reply) {
      await giveUp('ответ лида удалён');
      return;
    }
    const replyText = reply.body ?? '';

    // Строка доски: до передачи (manual, auto) скрыта, без передачи (none) — сразу у клиента.
    await getOrCreateBoard(instantlyDb, proj.id);
    await upsertBoardRow(instantlyDb, {
      qualificationId: current.recipient_id,
      sourceQualificationId: current.reply_id,
      projectId: proj.id,
      campaignId: current.campaign_id,
      campaignName: (campaign as { name?: string } | null)?.name ?? ctx.campaignName,
      leadEmail: ctx.to,
      leadName: ctx.leadName,
      companyName: ctx.companyName,
      phone: replyPhone(replyText),
      website: ctx.website,
      requestText: leadBoardRequestText({ text: replyText }),
      stepNumber: verdict.last_step_sent ?? null,
      replyTimestamp: reply.received_at ?? reply.created_at,
      requiresSpecialistReview: mode !== 'none',
      source: 'sender',
    });
    if (!current.board_written_at) await finish({ board_written_at: deps.now().toISOString() });

    // Передача уже есть (из «Писем» или прошлая попытка автопередачи) — карточка
    // «в очереди» или сразу «передано». Своя автопередача, которая не ушла, —
    // тоже итог: второе письмо лиду и клиенту без человека не отправляем.
    const latest = await latestHandoff(db, current.recipient_id);
    const existing = latest && latest.status !== 'failed' ? latest : null;
    const ownFailed = latest?.status === 'failed'
      && (latest.id === current.manual_message_id || Date.parse(latest.created_at) >= Date.parse(current.created_at)) ? latest : null;
    let blocked = existing ? null : ctx.blocked;
    let status: CardStatus = existing?.status === 'sent' ? 'sent' : existing ? 'queued' : 'card_sent';
    let manualMessageId = existing?.id ?? current.manual_message_id;
    if (status === 'sent') {
      // Лид уже у клиента — строку открыть сейчас, а не после карточки.
      await setBoardReview(instantlyDb, current.recipient_id, false);
      await finish({ board_published_at: deps.now().toISOString(), manual_message_id: manualMessageId });
    }
    if (mode === 'auto' && !existing && ownFailed) {
      status = 'queued';
      manualMessageId = ownFailed.id;
      blocked = null;
    }

    let draft = current.draft_text;
    if (mode !== 'none' && !existing && !isPermanentHandoffBlock(blocked) && !draft) {
      draft = await (deps.draft ?? buildHandoffDraft)({
        aiAdapt: ctx.aiAdapt,
        legend: ctx.legend,
        leadName: ctx.leadName,
        leadReplyText: replyText,
        apiKey: env.OPENROUTER_INSTANTLY_LEAD_API_KEY || env.OPENROUTER_BRIEF_API_KEY || '',
      });
      await finish({ draft_text: draft });
    }

    // Временная помеха (ящик, стоп-листы) не прячет лида: карточка уходит с
    // причиной, автопередачу повторит шаг auto_retry.
    if (mode === 'auto' && !existing && !ownFailed) {
      if (!blocked) {
        const quotes = await handoffQuotesCardReply(db, current, ctx);
        const ccIssue = handoffCcIssue(ctx);
        if (!quotes) blocked = 'Есть более свежий ответ лида — передайте из «Писем» «Рассылки»';
        else if (ccIssue) blocked = ccIssue;
        else {
          // Сначала письмо, потом карточка: повтор после сбоя увидит передачу, а не «передать нельзя».
          try {
            const queued = await enqueueSenderHandoff({ db, ctx, text: draft || ctx.draft, cc: ctx.cc, userId: proj.specialist_user_id! });
            manualMessageId = queued.messageId;
          } catch (error) {
            if (!(error instanceof HandoffAlreadyQueuedError)) throw error;
            manualMessageId = (await activeHandoff(db, current.recipient_id))?.id ?? manualMessageId;
          }
          await finish({ manual_message_id: manualMessageId });
          status = 'queued';
        }
      }
    }

    const people2 = await mentions(db, [responsibleUserId, people.pmUserId].filter((id): id is string => Boolean(id)));
    const boardLink = await getBoardLinkForProject(instantlyDb, proj.id);
    const html = buildProjectLeadCardHtml({
      mode,
      responsible: responsibleUserId ? people2.get(responsibleUserId) ?? null : null,
      pm: people.pmUserId ? people2.get(people.pmUserId) ?? null : null,
      contact: ctx.leadName ? `${ctx.leadName} (${ctx.to})` : ctx.to,
      companyName: ctx.companyName,
      phone: replyPhone(replyText),
      website: ctx.website,
      clientName: proj.client,
      campaignName: (campaign as { name?: string } | null)?.name ?? ctx.campaignName,
      replySubject: reply.subject,
      replyText,
      aiReason: (qualification as { ai_reason?: string | null } | null)?.ai_reason ?? null,
      draft,
      cc: ctx.cc,
      blockedReason: blocked,
      boardLink,
      replyId: current.reply_id,
    });
    const keyboard = status !== 'card_sent'
      ? projectLeadKeyboard({ mode: 'auto', recipientId: current.recipient_id, token: tg.token, blockedReason: null, autoSendOn: true, hasResponsible: false, url: threadUrl(current.recipient_id, env) })
      : projectLeadKeyboard({
        mode, recipientId: current.recipient_id, token: tg.token, blockedReason: blocked,
        autoSendOn: proj.handoff_auto_send === true, hasResponsible: Boolean(responsibleUserId), url: threadUrl(current.recipient_id, env),
      });

    // Уведомление в Portal и журнал — для эскалации непрочитанного лида руководителю.
    // Лид, переданный ещё до карточки, решения не ждёт — эскалировать нечего.
    if (responsibleUserId && status !== 'sent') {
      const { data: existingNotes, error: notesError } = await db.from('notifications').select('user_id')
        .eq('type', 'lead_new').eq('entity_type', 'lead_qualification').eq('entity_id', current.reply_id);
      if (notesError) throw new TransientCardError(`уведомление: ${notesError.message}`);
      if (!(existingNotes ?? []).length) {
        const contact = ctx.leadName ?? ctx.to;
        const campaignLabel = (campaign as { name?: string } | null)?.name;
        const { error: insertError } = await db.from('notifications').insert({
          user_id: responsibleUserId,
          type: 'lead_new',
          title: 'Новый квалифицированный лид',
          body: `${contact}${ctx.companyName ? ` — ${ctx.companyName}` : ''}${campaignLabel ? ` (${campaignLabel})` : ''}`,
          entity_type: 'lead_qualification',
          entity_id: current.reply_id,
        });
        if (insertError) throw new TransientCardError(`уведомление: ${insertError.message}`);
      }
    }

    // Карточка, которая уходит уже «в очереди» или «передано», сразу со строкой статуса.
    const statusLine = status === 'card_sent' ? null
      : cardStatusLine({ status, decided_by_telegram_id: null }, { error: existing?.error ?? ownFailed?.error ?? null, cc: existing?.cc_emails ?? ctx.cc });
    const shown = statusLine ? `${html}\n\n${statusLine}` : html;
    let messageId: number | null = null;
    let messageChat = tg.chatId;
    if (current.tg_message_id && current.tg_chat_id) {
      // Прошлая попытка карточку отправила, а записать итог не успела — правим ту же, вторую не шлём.
      try {
        await (deps.edit ?? editSenderProjectLeadCard)({ token: tg.token, chatId: current.tg_chat_id, messageId: current.tg_message_id, html: shown, keyboard });
        messageId = current.tg_message_id;
        messageChat = current.tg_chat_id;
      } catch (error) {
        if (!isFinalTelegramRefusal(errorText(error))) throw error;
      }
    }
    if (messageId == null) {
      messageId = await (deps.post ?? postSenderProjectLeadCard)({ token: tg.token, chatId: tg.chatId, threadId: tg.threadId, html: shown, keyboard });
      // Сразу запомнить сообщение: сбой записи ниже не превратится во вторую карточку.
      const { error: savedError } = await db.from('sender_project_lead_cards')
        .update({ tg_chat_id: tg.chatId, tg_message_id: messageId, tg_html: html, tg_keyboard: keyboard, updated_at: deps.now().toISOString() })
        .eq('recipient_id', current.recipient_id).eq('status', 'pending');
      if (savedError) log('warn', `Карточка лида ${current.reply_id}: сообщение не запомнено: ${savedError.message}`);
    }
    const sentAt = deps.now().toISOString();
    await finish({
      status,
      tg_chat_id: messageChat,
      tg_message_id: messageId,
      tg_html: html,
      tg_keyboard: keyboard,
      tg_rendered_status: status,
      blocked_reason: blocked,
      manual_message_id: manualMessageId,
      // Отложенную автопередачу повторит шаг auto_retry; постоянную помеху — нет.
      next_attempt_at: mode === 'auto' && status === 'card_sent' && blocked
        ? (isPermanentHandoffBlock(blocked) ? NEVER : new Date(deps.now().getTime() + AUTO_RETRY_MIN * 60_000).toISOString())
        : null,
      last_error: null,
    });
    if (status === 'sent') await markNotificationsRead(db, current.reply_id, log);
    else if (responsibleUserId) {
      const { error: logError } = await db.from('deadline_notification_log').upsert({
        entity_type: 'lead_qualification', entity_id: current.reply_id, level: 'specialist',
        tg_sent: true, tg_message_id: messageId, tg_sent_at: sentAt, tg_error: null,
      }, { onConflict: 'entity_type,entity_id,level' });
      if (logError) log('warn', `Лид ${current.reply_id}: журнал уведомлений не записан: ${logError.message}`);
    }
  } catch (error) {
    const message = errorText(error);
    log('warn', `Карточка лида ${current.reply_id} (попытка ${attempts}): ${message}`);
    const { error: markError } = await db.from('sender_project_lead_cards')
      .update({ last_error: message, updated_at: deps.now().toISOString() }).eq('recipient_id', current.recipient_id).eq('status', 'pending');
    if (markError) log('warn', `Карточка лида ${current.reply_id}: причина сбоя не записана: ${markError.message}`);
  }
}

/** Перерисовать карточку под её статус. «Сообщения нет» — тоже итог: больше не пытаемся. */
export async function renderCard(
  deps: Pick<ProjectLeadCardDeps, 'db' | 'log' | 'edit'> & { env: NodeJS.ProcessEnv; now: () => Date },
  card: ProjectLeadCardRow,
  handoff: { error: string | null; cc: string[] | null },
): Promise<void> {
  if (!card.tg_message_id || !card.tg_chat_id || card.tg_rendered_status === card.status) return;
  const tg = leadAlertsTelegram(deps.env);
  if (!tg) return;
  const line = cardStatusLine(card, handoff);
  const html = line ? `${card.tg_html ?? ''}\n\n${line}` : card.tg_html ?? '';
  const keyboard = card.status === 'card_sent' ? card.tg_keyboard ?? [] : urlOnly(card.tg_keyboard);
  try {
    await (deps.edit ?? editSenderProjectLeadCard)({ token: tg.token, chatId: card.tg_chat_id, messageId: card.tg_message_id, html, keyboard });
  } catch (error) {
    const message = errorText(error);
    // Сеть и «слишком часто» — повторим; отказ Telegram по самому сообщению
    // (удалено, нет прав, не разобрал) не пройдёт — фиксируем и не крутим.
    if (!isFinalTelegramRefusal(message)) throw error;
    deps.log('warn', `Карточка лида ${card.reply_id}: правка не принята Telegram (${message})`);
  }
  const { error } = await deps.db.from('sender_project_lead_cards')
    .update({ tg_rendered_status: card.status, updated_at: deps.now().toISOString() }).eq('recipient_id', card.recipient_id).eq('status', card.status);
  if (error) throw new Error(`sender_project_lead_cards render: ${error.message}`);
}

export async function setBoardReview(instantlyDb: SupabaseClient | null, recipientId: string, hidden: boolean): Promise<void> {
  if (!instantlyDb) throw new Error('база Instantly не настроена — доска лидов недоступна');
  const { error } = await instantlyDb.from('project_lead_board_rows')
    .update({ specialist_review_required: hidden }).eq('qualification_id', recipientId);
  if (error) throw new Error(`project_lead_board_rows: ${error.message}`);
}

type EventKind = 'sent' | 'publish' | 'failed' | 'not_lead' | 'auto_retry' | 'stuck' | 'render';

interface CardEvent {
  recipient_id: string;
  kind: EventKind;
  status: CardStatus;
  handoff_id: string | null;
  handoff_status: string | null;
  handoff_error: string | null;
  handoff_cc: string[] | null;
  lead_verdict: string | null;
  lead_verdict_source: string | null;
}

async function handleEvent(deps: ProjectLeadCardDeps & { env: NodeJS.ProcessEnv; now: () => Date }, event: CardEvent): Promise<void> {
  const { db, instantlyDb } = deps;
  let card = await loadCard(db, event.recipient_id);
  if (!card || card.status !== event.status) return;
  let handoff = { error: event.handoff_error, cc: event.handoff_cc };
  const transition = async (to: CardStatus, patch: Record<string, unknown> = {}): Promise<boolean> => {
    const { data, error } = await db.from('sender_project_lead_cards')
      .update({ ...patch, status: to, updated_at: deps.now().toISOString() })
      .eq('recipient_id', card!.recipient_id).eq('status', card!.status).select(CARD_SELECT).maybeSingle();
    if (error) throw new Error(`sender_project_lead_cards: ${error.message}`);
    if (data) card = data as ProjectLeadCardRow;
    return Boolean(data);
  };
  const patchCard = async (patch: Record<string, unknown>) => {
    const { data, error } = await db.from('sender_project_lead_cards')
      .update({ ...patch, updated_at: deps.now().toISOString() }).eq('recipient_id', card!.recipient_id).eq('status', card!.status)
      .select(CARD_SELECT).maybeSingle();
    if (error) throw new Error(`sender_project_lead_cards: ${error.message}`);
    if (data) card = data as ProjectLeadCardRow;
  };

  switch (event.kind) {
    case 'sent': {
      // Письмо передачи ушло (в том числе из «Писем») — лид у клиента: открыть строку доски.
      if (!card.board_written_at) {
        if (!instantlyDb) throw new Error('база Instantly не настроена — доска лидов недоступна');
        const reply = await loadReply(db, card.reply_id);
        const { data: campaign } = await db.from('sender_campaigns').select('name').eq('id', card.campaign_id).maybeSingle();
        await getOrCreateBoard(instantlyDb, card.project_id);
        await upsertBoardRow(instantlyDb, {
          qualificationId: card.recipient_id,
          sourceQualificationId: card.reply_id,
          projectId: card.project_id,
          campaignId: card.campaign_id,
          campaignName: (campaign as { name?: string } | null)?.name ?? null,
          leadEmail: reply?.from_email ?? null,
          leadName: reply?.from_name ?? null,
          companyName: null,
          phone: replyPhone(reply?.body ?? null),
          website: null,
          requestText: leadBoardRequestText({ text: reply?.body ?? '' }),
          stepNumber: null,
          replyTimestamp: reply?.received_at ?? reply?.created_at ?? null,
          source: 'sender',
        });
      }
      // Строка могла остаться скрытой с прошлой попытки — открываем всегда.
      await setBoardReview(instantlyDb, card.recipient_id, false);
      const nowIso = deps.now().toISOString();
      if (await transition('sent', { board_written_at: card.board_written_at ?? nowIso, board_published_at: nowIso, manual_message_id: event.handoff_id })) {
        await markNotificationsRead(db, card.reply_id, deps.log);
      }
      break;
    }
    case 'publish':
      // Ушло, а карточку ещё не доставили (Telegram недоступен, выключатель): строку — сейчас.
      await setBoardReview(instantlyDb, card.recipient_id, false);
      await patchCard({ board_published_at: deps.now().toISOString() });
      return;
    case 'failed':
      await transition('handoff_failed', { manual_message_id: event.handoff_id });
      break;
    case 'not_lead':
      // «Не лид» поставили в «Рассылке» — строку скрыть, карточку закрыть.
      if (card.board_written_at) await setBoardReview(instantlyDb, card.recipient_id, true);
      if (await transition('rejected', { decided_at: deps.now().toISOString() })) {
        await markNotificationsRead(db, card.reply_id, deps.log);
      }
      break;
    case 'stuck':
      // «Передать» заняло карточку, а письмо так и не встало: вернуть кнопки.
      await transition('card_sent', { decided_by_user_id: null, decided_by_telegram_id: null, decided_at: null });
      break;
    case 'auto_retry': {
      const later = new Date(deps.now().getTime() + AUTO_RETRY_MIN * 60_000).toISOString();
      // Сдаёмся один раз и говорим об этом на карточке (строка статуса), а не
      // молча: строка доски остаётся скрытой, передать можно из «Писем».
      const giveUp = (reason: string) => patchCard({ blocked_reason: reason, next_attempt_at: NEVER, tg_rendered_status: null });
      if (deps.now().getTime() - Date.parse(card.created_at) > DELIVERY_WINDOW_MS) {
        await giveUp(`за 7 суток не вышло — ${card.blocked_reason ?? 'причина не сохранена'}`);
        break;
      }
      // Передачу выключили — ждём включения, письмо само не ставим.
      if (!handoffEnabled(deps.env)) { await patchCard({ next_attempt_at: later }); return; }
      const { data: project, error: projectError } = await db.from('projects').select('specialist_user_id').eq('id', card.project_id).maybeSingle();
      if (projectError) throw new Error(`projects: ${projectError.message}`);
      const specialist = (project as { specialist_user_id?: string | null } | null)?.specialist_user_id;
      const ctx = await loadSenderHandoffContext(db, instantlyDb, card.recipient_id);
      if (!ctx) { await giveUp('переписка не найдена'); break; }
      if (ctx.blocked && isPermanentHandoffBlock(ctx.blocked)) { await giveUp(ctx.blocked); break; }
      // Остальное может пройти само: ящик починят, ответственного назначат,
      // более свежий ответ лида станет частью карточки.
      const quotes = !ctx.blocked && specialist ? await handoffQuotesCardReply(db, card, ctx) : true;
      const wait = ctx.blocked ?? (!specialist ? 'у проекта нет ответственного' : null) ?? handoffCcIssue(ctx)
        ?? (!quotes ? 'Есть более свежий ответ лида — передайте из «Писем» «Рассылки»' : null);
      if (wait || !specialist) {
        await patchCard({ blocked_reason: wait, next_attempt_at: later });
        return;
      }
      let messageId: string | null = null;
      try {
        messageId = (await enqueueSenderHandoff({ db, ctx, text: card.draft_text || ctx.draft, cc: ctx.cc, userId: specialist })).messageId;
      } catch (error) {
        if (!(error instanceof HandoffAlreadyQueuedError)) throw error;
        messageId = (await activeHandoff(db, card.recipient_id))?.id ?? null;
      }
      await transition('queued', { manual_message_id: messageId, blocked_reason: null, next_attempt_at: null });
      handoff = { error: null, cc: ctx.cc };
      break;
    }
    case 'render':
      if (card.status === 'rejected') {
        // «Не лид» из Telegram мог оборваться на полпути (сбой, перезапуск).
        // Передача из «Писем» уже стоит — нажатие и так отказало бы: вернуть кнопки.
        if (await activeHandoff(db, card.recipient_id)) {
          await transition('card_sent', { decided_by_user_id: null, decided_by_telegram_id: null, decided_at: null });
          break;
        }
        // Иначе дописать итог переписки и скрыть строку. Уступаем только решению
        // человека в «Рассылке», принятому после нажатия.
        const { data: verdictRow, error: verdictError } = await db.from('sender_recipients')
          .select('lead_verdict, lead_verdict_source, lead_verdict_at').eq('id', card.recipient_id).maybeSingle();
        if (verdictError) throw new Error(`sender_recipients: ${verdictError.message}`);
        const verdict = verdictRow as { lead_verdict: string | null; lead_verdict_source: string | null; lead_verdict_at: string | null } | null;
        const decidedAt = card.decided_at ? Date.parse(card.decided_at) : 0;
        const humanAfter = verdict?.lead_verdict_source === 'manual' && Boolean(verdict.lead_verdict_at) && Date.parse(verdict.lead_verdict_at!) > decidedAt;
        const manualNotLead = verdict?.lead_verdict === 'not_lead' && verdict.lead_verdict_source === 'manual';
        if (card.decided_by_user_id && !humanAfter && !manualNotLead) {
          const { error } = await db.from('sender_recipients').update({
            lead_verdict: 'not_lead', lead_verdict_source: 'manual', lead_verdict_at: card.decided_at ?? deps.now().toISOString(), lead_verdict_by: card.decided_by_user_id,
          }).eq('id', card.recipient_id);
          if (error) throw new Error(`sender_recipients: ${error.message}`);
        }
        if (card.board_written_at && !(humanAfter && verdict?.lead_verdict === 'lead')) await setBoardReview(instantlyDb, card.recipient_id, true);
        await markNotificationsRead(db, card.reply_id, deps.log);
      }
      break;
  }
  await renderCard(deps, card, handoff);
}

export interface ProjectLeadCardsResult {
  created: number;
  merged: number;
  delivered: number;
  events: number;
}

export async function runSenderProjectLeadCardsPass(input: ProjectLeadCardDeps): Promise<ProjectLeadCardsResult> {
  const deps = { ...input, env: input.env ?? process.env, now: input.now ?? (() => new Date()) };
  const { db, log } = deps;
  const result: ProjectLeadCardsResult = { created: 0, merged: 0, delivered: 0, events: 0 };

  const { data: settings, error: settingsError } = await db.from('sender_project_lead_settings').select('enabled').eq('id', true).maybeSingle();
  if (settingsError) log('warn', `Карточки лидов проектов: настройка не прочитана: ${settingsError.message}`);
  const enabled = !settingsError && (settings as { enabled?: boolean } | null)?.enabled === true;

  if (enabled) {
    const { data: candidates, error } = await db.rpc('sender_project_lead_candidates', { p_limit: CARD_BATCH });
    if (error) throw new Error(`sender_project_lead_candidates: ${error.message}`);
    for (const row of (candidates ?? []) as Array<{ reply_id: string; recipient_id: string; campaign_id: string; project_id: string; has_card: boolean; card_status: CardStatus | null }>) {
      try {
        if (row.has_card && row.card_status === 'undelivered') {
          // Карточку прошлого лида так и не доставили — новый ответ-лид открывает её заново.
          const reopenedAt = deps.now().toISOString();
          const { data: card } = await db.from('sender_project_lead_cards').select('merged_reply_ids').eq('recipient_id', row.recipient_id).maybeSingle();
          const merged = (card as { merged_reply_ids?: string[] } | null)?.merged_reply_ids ?? [];
          const { error: reopenError } = await db.from('sender_project_lead_cards').update({
            status: 'pending', reply_id: row.reply_id, merged_reply_ids: [...new Set([...merged, row.reply_id])],
            attempts: 0, next_attempt_at: null, last_error: null, created_at: reopenedAt, updated_at: reopenedAt,
            // Новый лид — новое сообщение со звуком, а не правка старого где-то выше в чате.
            tg_chat_id: null, tg_message_id: null, tg_html: null, tg_keyboard: null, tg_rendered_status: null,
          }).eq('recipient_id', row.recipient_id).eq('status', 'undelivered');
          if (reopenError) throw new Error(reopenError.message);
          result.created += 1;
          continue;
        }
        if (row.has_card) {
          await mergeReply(deps, row.recipient_id, row.reply_id);
          result.merged += 1;
          continue;
        }
        const createdAt = deps.now().toISOString();
        const { data: inserted, error: insertError } = await db.from('sender_project_lead_cards')
          .upsert({
            recipient_id: row.recipient_id, reply_id: row.reply_id, campaign_id: row.campaign_id,
            project_id: row.project_id, merged_reply_ids: [row.reply_id], status: 'pending',
            attempts: 0, next_attempt_at: null, created_at: createdAt, updated_at: createdAt,
          }, { onConflict: 'recipient_id', ignoreDuplicates: true })
          .select('recipient_id');
        if (insertError) throw new Error(insertError.message);
        if ((inserted ?? []).length) result.created += 1;
      } catch (err) {
        log('warn', `Лид ${row.reply_id}: карточка не заведена: ${errorText(err)}`);
      }
    }

    // Новые (без срока) первыми, затем подошедшие по лесенке.
    const nowMs = deps.now().getTime();
    const { data: pending, error: pendingError } = await db.from('sender_project_lead_cards').select(CARD_SELECT)
      .eq('status', 'pending').order('next_attempt_at', { ascending: true, nullsFirst: true }).limit(CARD_BATCH * 5);
    if (pendingError) throw new Error(`sender_project_lead_cards pending: ${pendingError.message}`);
    const due = ((pending ?? []) as ProjectLeadCardRow[])
      .filter((card) => !card.next_attempt_at || Date.parse(card.next_attempt_at) <= nowMs).slice(0, CARD_BATCH);
    for (const card of due) {
      await deliverCard(deps, card);
      result.delivered += 1;
    }
  }

  const { data: events, error: eventsError } = await db.rpc('sender_project_lead_card_events', { p_limit: EVENT_BATCH });
  if (eventsError) throw new Error(`sender_project_lead_card_events: ${eventsError.message}`);
  for (const event of (events ?? []) as CardEvent[]) {
    try {
      await handleEvent(deps, event);
      result.events += 1;
    } catch (err) {
      log('warn', `Карточка лида ${event.recipient_id}: шаг не выполнен: ${errorText(err)}`);
    }
  }
  return result;
}

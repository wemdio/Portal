import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_LEAD_CRITERIA, LEAD_CRITERIA_MAX, isDefaultLeadCriteria } from './settings';

/**
 * Вкладка «Квалификация» автоаутрича: история оценок ответов папки и её
 * настройки (docs/superpowers/specs/2026-09-29-outreach-qualification-tab-design.md).
 *
 * Здесь — запросы для API /api/tools/sender-leads/* и типы ответа, общие для
 * роутов и экрана. Клиент импортирует только типы.
 */

export const HISTORY_PAGE_SIZE = 30;

/** Плашки-фильтры: «Всего · Лиды · Ушли в чат · Не лиды · В очереди · Ошибки». */
export const HISTORY_FILTERS = ['all', 'lead', 'sent', 'not_lead', 'pending', 'error'] as const;
export type LeadHistoryFilter = (typeof HISTORY_FILTERS)[number];
export type LeadHistoryCounts = Record<LeadHistoryFilter, number>;

/** Ответ на список длиной в письмо, а не в выгрузку ящика: хвост цитат режем. */
const REPLY_BODY_MAX = 20_000;

export type LeadVerdict = 'lead' | 'not_lead';

export interface LeadHistoryRowDto {
  replyId: string;
  recipientId: string;
  /** Оценка ИИ по этому ответу; skipped в историю не попадает. */
  status: 'pending' | 'lead' | 'not_lead' | 'error';
  aiReason: string | null;
  interestSignals: string[];
  criteriaUsed: boolean;
  attempts: number;
  lastError: string | null;
  qualifiedAt: string | null;
  tgSentAt: string | null;
  tgError: string | null;
  replyAt: string | null;
  replyFrom: string | null;
  replyFromName: string | null;
  replySubject: string | null;
  replyBody: string | null;
  companyName: string | null;
  /** Адрес, на который мы писали. */
  recipientEmail: string | null;
  campaignName: string | null;
  /** Итог по переписке (sender_recipients): последнее решение ИИ или человека. */
  verdict: LeadVerdict | null;
  verdictSource: 'ai' | 'manual' | null;
  verdictAt: string | null;
}

export interface LeadHistoryDto {
  folderExists: boolean;
  rows: LeadHistoryRowDto[];
  total: number;
  pageSize: number;
  counts: LeadHistoryCounts;
}

export interface LeadSettingsDto {
  /** false — папки ещё нет: создаётся первой заливкой в «Рассылку». */
  folderExists: boolean;
  folderName: string | null;
  enabled: boolean;
  telegram: boolean;
  criteria: string;
}

export interface LeadSettingsInput {
  enabled: boolean;
  telegram: boolean;
  criteria: string;
}

/** Метка переписки и последняя оценка ИИ — для окна переписки в «Рассылке». */
export interface ThreadVerdictDto {
  verdict: LeadVerdict | null;
  verdictSource: 'ai' | 'manual' | null;
  verdictAt: string | null;
  lastQualification: {
    status: 'pending' | 'lead' | 'not_lead' | 'error' | 'skipped';
    aiReason: string | null;
    qualifiedAt: string | null;
    tgSentAt: string | null;
  } | null;
}

/** Ключ папки из адреса: auto_en / auto_ru. Что угодно другое — не ключ. */
export function parseFolderKey(value: string | null): string | null {
  const key = (value ?? '').trim();
  return /^[a-z0-9_]{1,40}$/.test(key) ? key : null;
}

export function parseHistoryFilter(value: string | null): LeadHistoryFilter {
  return (HISTORY_FILTERS as readonly string[]).includes(value ?? '') ? (value as LeadHistoryFilter) : 'all';
}

interface FolderLeadRow {
  id: string;
  name: string;
  lead_criteria: string | null;
  leads_enabled: boolean;
  leads_telegram: boolean;
}

export async function findFolderByKey(db: SupabaseClient, key: string): Promise<FolderLeadRow | null> {
  const { data, error } = await db
    .from('sender_folders')
    .select('id, name, lead_criteria, leads_enabled, leads_telegram')
    .eq('key', key)
    .maybeSingle();
  if (error) throw new Error(`sender_folders: ${error.message}`);
  return (data as FolderLeadRow | null) ?? null;
}

export function settingsDto(folder: FolderLeadRow | null): LeadSettingsDto {
  // Своего правила нет — показываем пересказ общих правил, а не пустое поле.
  if (!folder) return { folderExists: false, folderName: null, enabled: true, telegram: true, criteria: DEFAULT_LEAD_CRITERIA };
  return {
    folderExists: true,
    folderName: folder.name,
    enabled: folder.leads_enabled,
    telegram: folder.leads_telegram,
    criteria: folder.lead_criteria ?? DEFAULT_LEAD_CRITERIA,
  };
}

/**
 * Проверка тела PUT настроек. criteria обрезается по краям; пусто — общие
 * правила квалификатора (в базе null).
 */
export function parseSettingsInput(body: unknown): { ok: true; value: { leads_enabled: boolean; leads_telegram: boolean; lead_criteria: string | null } } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Невалидный JSON' };
  const { enabled, telegram, criteria } = body as Record<string, unknown>;
  if (typeof enabled !== 'boolean' || typeof telegram !== 'boolean') {
    return { ok: false, error: 'enabled и telegram — да/нет' };
  }
  if (criteria != null && typeof criteria !== 'string') return { ok: false, error: 'criteria — текст' };
  const text = (criteria ?? '').trim();
  if (text.length > LEAD_CRITERIA_MAX) {
    return { ok: false, error: `«Что считать лидом» — не длиннее ${LEAD_CRITERIA_MAX} символов` };
  }
  // Текст по умолчанию — не своё правило: в базе null, ИИ идёт по общим правилам.
  return {
    ok: true,
    value: { leads_enabled: enabled, leads_telegram: telegram, lead_criteria: text && !isDefaultLeadCriteria(text) ? text : null },
  };
}

/**
 * Оценки ответов папки. Папка — у рассылки, поэтому фильтр идёт через
 * встроенную sender_campaigns с !inner: строки чужих папок отсекаются в базе,
 * без выкачивания списка рассылок папки. «Пропущено» (старые ответы и ответы
 * при выключенной оценке) в историю и счётчики не входит.
 */
function historyQuery(
  db: SupabaseClient,
  folderId: string,
  select: string,
  filter: LeadHistoryFilter,
  head: boolean,
) {
  let query = db
    .from('sender_reply_qualifications')
    .select(select, head ? { count: 'exact', head: true } : { count: 'exact' })
    .eq('sender_campaigns.folder_id', folderId)
    .neq('status', 'skipped');
  if (filter === 'sent') query = query.not('tg_sent_at', 'is', null);
  else if (filter !== 'all') query = query.eq('status', filter);
  return query;
}

const LIST_SELECT = [
  'reply_id, recipient_id, status, ai_reason, interest_signals, criteria_used, attempts, last_error',
  'qualified_at, tg_sent_at, tg_error, created_at',
  'sender_replies(from_email, from_name, subject, body, received_at, created_at)',
  'sender_recipients(email, name, lead_verdict, lead_verdict_source, lead_verdict_at)',
  'sender_campaigns!inner(name, folder_id)',
].join(', ');

type One<T> = T | T[] | null;
function one<T>(value: One<T>): T | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

interface ListRow {
  reply_id: string;
  recipient_id: string;
  status: LeadHistoryRowDto['status'];
  ai_reason: string | null;
  interest_signals: string[] | null;
  criteria_used: boolean;
  attempts: number;
  last_error: string | null;
  qualified_at: string | null;
  tg_sent_at: string | null;
  tg_error: string | null;
  created_at: string;
  sender_replies: One<{
    from_email: string | null;
    from_name: string | null;
    subject: string | null;
    body: string | null;
    received_at: string | null;
    created_at: string;
  }>;
  sender_recipients: One<{
    email: string;
    name: string | null;
    lead_verdict: LeadVerdict | null;
    lead_verdict_source: 'ai' | 'manual' | null;
    lead_verdict_at: string | null;
  }>;
  sender_campaigns: One<{ name: string; folder_id: string }>;
}

function toRowDto(row: ListRow): LeadHistoryRowDto {
  const reply = one(row.sender_replies);
  const recipient = one(row.sender_recipients);
  const campaign = one(row.sender_campaigns);
  return {
    replyId: row.reply_id,
    recipientId: row.recipient_id,
    status: row.status,
    aiReason: row.ai_reason,
    interestSignals: row.interest_signals ?? [],
    criteriaUsed: row.criteria_used,
    attempts: row.attempts,
    lastError: row.last_error,
    qualifiedAt: row.qualified_at,
    tgSentAt: row.tg_sent_at,
    tgError: row.tg_error,
    replyAt: reply?.received_at ?? reply?.created_at ?? row.created_at,
    replyFrom: reply?.from_email ?? null,
    replyFromName: reply?.from_name ?? null,
    replySubject: reply?.subject ?? null,
    replyBody: reply?.body ? reply.body.slice(0, REPLY_BODY_MAX) : null,
    companyName: recipient?.name ?? null,
    recipientEmail: recipient?.email ?? null,
    campaignName: campaign?.name ?? null,
    verdict: recipient?.lead_verdict ?? null,
    verdictSource: recipient?.lead_verdict_source ?? null,
    verdictAt: recipient?.lead_verdict_at ?? null,
  };
}

export async function loadLeadHistory(
  db: SupabaseClient,
  folderId: string,
  filter: LeadHistoryFilter,
  page: number,
): Promise<Omit<LeadHistoryDto, 'folderExists'>> {
  const from = (page - 1) * HISTORY_PAGE_SIZE;
  const COUNT_SELECT = 'reply_id, sender_campaigns!inner(folder_id)';

  const [list, ...counts] = await Promise.all([
    historyQuery(db, folderId, LIST_SELECT, filter, false)
      // Сверху новые. Строка оценки заводится, как только ответ попал в
      // очередь, — её время и есть «когда пришёл» с точностью до круга воркера.
      .order('created_at', { ascending: false })
      .order('reply_id', { ascending: true })
      .range(from, from + HISTORY_PAGE_SIZE - 1),
    ...HISTORY_FILTERS.map((f) => historyQuery(db, folderId, COUNT_SELECT, f, true)),
  ]);

  if (list.error) throw new Error(`sender_reply_qualifications: ${list.error.message}`);
  const countMap = {} as LeadHistoryCounts;
  HISTORY_FILTERS.forEach((f, i) => {
    const res = counts[i];
    if (res.error) throw new Error(`sender_reply_qualifications count: ${res.error.message}`);
    countMap[f] = res.count ?? 0;
  });

  return {
    rows: ((list.data ?? []) as unknown as ListRow[]).map(toRowDto),
    total: list.count ?? 0,
    pageSize: HISTORY_PAGE_SIZE,
    counts: countMap,
  };
}

export const EMPTY_COUNTS: LeadHistoryCounts = { all: 0, lead: 0, sent: 0, not_lead: 0, pending: 0, error: 0 };

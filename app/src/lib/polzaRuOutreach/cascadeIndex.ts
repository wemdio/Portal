import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { chunkForInFilter } from '@/lib/sender/inFilter';
import { stripQuoted } from '@/lib/senderLeads/telegram';

import {
  cascadeDecision,
  classifyCascadeReply,
  isProduct,
  legacyStepOf,
  stepOfProduct,
  type CascadeDecision,
  type CascadeFacts,
  type CascadeStep,
} from './cascade';
import { CHAIN_TYPES, type ChainType, type Signal } from './types';

/**
 * Индекс каскада: что каждой компании уже предлагали и пора ли писать снова.
 * Собирается из строк прошлых запусков и из «Рассылки» (получатели, письма,
 * ответы, разговор ИИ, стоп-лист) — отдельной таблицы состояния нет.
 *
 * Компания — это домен и ИНН: строки с общим доменом или общим ИНН склеиваются
 * в одну (одна компания в нескольких запусках, тот же ИНН при другом домене).
 * В индекс попадают только компании, которым что-то уходило: строка `ready`,
 * которая в «Рассылку» так и не ушла, — не написанная (спека, решение 11), такая
 * компания для раннера новая.
 */

export interface CascadeCompany {
  domain: string | null;
  inn: string | null;
  /** Последняя из ушедших строк компании. */
  lastRowId: string;
  companyName: string | null;
  /**
   * Сигналы последней строки. Подгружаются только у компаний с решением `due`
   * (они нужны вернувшимся); у остальных — пусто, чтобы не тащить тяжёлый jsonb
   * по всем ~6 тысячам строк при каждом запуске.
   */
  signals: Signal[];
  facts: CascadeFacts;
  decision: CascadeDecision;
}

export interface CascadeIndex {
  byDomain: Map<string, CascadeCompany>;
  byInn: Map<string, CascadeCompany>;
  /** Компании с решением `due`: сначала те, чьё последнее письмо ушло раньше всех. */
  due: CascadeCompany[];
}

// Записи таблиц в том виде, как их отдаёт PostgREST (даты строками).

export interface RowRecord {
  id: string;
  normalized_domain: string | null;
  inn: string | null;
  company_name: string | null;
  chain_type: string | null;
  product: string | null;
  sender_campaign_id: string | null;
  sender_uploaded_at: string | null;
  created_at: string | null;
  recipient_email: string | null;
  emails: unknown;
}

export interface RecipientRecord {
  id: string;
  email: string | null;
  status: string | null;
  lead_verdict: string | null;
  lead_verdict_source: string | null;
  /** id строки запуска, текстом. */
  group_key: string | null;
}

export interface MessageRecord {
  recipient_id: string;
  sent_at: string | null;
}

export interface ConversationRecord {
  recipient_id: string;
  state: string | null;
  close_reason: string | null;
}

export interface ReplyRecord {
  recipient_id: string;
  body: string | null;
  received_at: string | null;
  created_at: string | null;
}

export interface CascadeRecords {
  /** Строки `ready` прошлых запусков (любые: ушедшие отбираются здесь). */
  rows: RowRecord[];
  /** Получатели «Рассылки» только из рассылок `polza_ru`. */
  recipients: RecipientRecord[];
  /** Ушедшие письма (`status = 'sent'`) этих получателей. */
  messages: MessageRecord[];
  conversations: ConversationRecord[];
  /** Ответы людей (`kind = 'human'`) этих получателей. */
  replies: ReplyRecord[];
  /** Адреса из общего стоп-листа, которые закрывают всю компанию (в нижнем регистре). */
  suppressedEmails: Set<string>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Цепочка из четырёх писем идёт около недели. Когда самих писем в базе нет
 * (рассылку удалили после отправки), конец цепочки — заливка + неделя: сразу
 * снова писать нельзя.
 */
const CHAIN_DAYS = 7;

/** «Рассылка» заработала 26.09.2026: строки старше без отметок заливки выгружались в Excel/Instantly. */
const SENDER_LAUNCH_MS = Date.UTC(2026, 8, 26);

const PAGE = 1000;
/** Запросов к базе одновременно: индекс собирается на старте запуска, базу не душим. */
const POOL = 4;

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function maxDate(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/** Тип цепочки из базы: незнакомая строка — как её отсутствие. */
function chainTypeOf(value: string | null): ChainType | null {
  return (CHAIN_TYPES as readonly string[]).includes(value ?? '') ? (value as ChainType) : null;
}

/**
 * Строка уходила, если её залили в «Рассылку» (дата или ссылка на рассылку —
 * письма бывают только у залитой строки) или выгрузили до «Рассылки».
 */
function wentOut(row: RowRecord): boolean {
  if (row.sender_uploaded_at || row.sender_campaign_id) return true;
  const created = toDate(row.created_at);
  return created !== null && created.getTime() < SENDER_LAUNCH_MS;
}

/** Какой шаг круга предложила строка: по продукту, у старых строк — по типу цепочки. */
function stepOfRow(row: RowRecord): CascadeStep {
  if (row.product && isProduct(row.product)) return stepOfProduct(row.product);
  return legacyStepOf(chainTypeOf(row.chain_type));
}

/** Когда у строки ушло последнее письмо; без писем в базе — приблизительно, см. CHAIN_DAYS. */
function lastSentOfRow(row: RowRecord, sentAt: Date | null): Date | null {
  if (sentAt) return sentAt;
  const created = toDate(row.created_at);
  if (!row.sender_uploaded_at && !row.sender_campaign_id) return created;
  const uploaded = toDate(row.sender_uploaded_at) ?? created;
  return uploaded ? addDays(uploaded, CHAIN_DAYS) : null;
}

/** Адреса строки: главный и список emails — в нижнем регистре. */
function rowAddresses(row: RowRecord): string[] {
  const out: string[] = [];
  if (row.recipient_email) out.push(row.recipient_email);
  if (Array.isArray(row.emails)) {
    for (const item of row.emails) {
      const email = item && typeof item === 'object' ? (item as { email?: unknown }).email : null;
      if (typeof email === 'string' && email) out.push(email);
    }
  }
  return out.map((email) => email.trim().toLowerCase()).filter(Boolean);
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Факты строки, из которых потом складываются факты компании. */
interface RowFacts {
  row: RowRecord;
  domain: string | null;
  inn: string | null;
  step: CascadeStep;
  lastSentAt: Date | null;
  chainRunning: boolean;
  lead: boolean;
  closed: boolean;
  suppressed: boolean;
  laterAt: Date | null;
}

/** Время строки для порядка «что предлагали раньше». */
function rowTime(item: RowFacts): number {
  return (item.lastSentAt ?? toDate(item.row.created_at))?.getTime() ?? 0;
}

function compareRows(a: RowFacts, b: RowFacts): number {
  return (
    rowTime(a) - rowTime(b) ||
    (toDate(a.row.created_at)?.getTime() ?? 0) - (toDate(b.row.created_at)?.getTime() ?? 0) ||
    (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0)
  );
}

/**
 * Индекс из записей таблиц — чистая функция, без обращений к базе.
 *
 * Лид, отказ, отписка и «напишите позже» берутся из ответов и меток, а не из
 * статуса получателя: `replied` ставится и по ответу после конца цепочки, и по
 * любому ответу в её середине.
 */
export function assembleCascadeIndex(records: CascadeRecords, now: Date, pauseDays: number): CascadeIndex {
  const recipientsByRow = new Map<string, RecipientRecord[]>();
  for (const recipient of records.recipients) {
    if (recipient.group_key) pushTo(recipientsByRow, recipient.group_key, recipient);
  }
  const sentAtByRecipient = new Map<string, Date>();
  for (const message of records.messages) {
    const newest = maxDate(sentAtByRecipient.get(message.recipient_id) ?? null, toDate(message.sent_at));
    if (newest) sentAtByRecipient.set(message.recipient_id, newest);
  }
  const conversationByRecipient = new Map<string, ConversationRecord>();
  for (const conversation of records.conversations) conversationByRecipient.set(conversation.recipient_id, conversation);
  const repliesByRecipient = new Map<string, ReplyRecord[]>();
  for (const reply of records.replies) pushTo(repliesByRecipient, reply.recipient_id, reply);

  const items: RowFacts[] = [];
  for (const row of records.rows) {
    if (!wentOut(row)) continue;
    const domain = row.normalized_domain || null;
    const inn = row.inn || null;
    // Без домена и ИНН компанию по индексу не найти.
    if (!domain && !inn) continue;

    const recipients = recipientsByRow.get(row.id) ?? [];
    let sentAt: Date | null = null;
    let chainRunning = false;
    let lead = false;
    let closed = false;
    let suppressed = rowAddresses(row).some((email) => records.suppressedEmails.has(email));
    let laterAt: Date | null = null;
    for (const recipient of recipients) {
      sentAt = maxDate(sentAt, sentAtByRecipient.get(recipient.id) ?? null);
      if (recipient.status === 'active') chainRunning = true;
      if (recipient.status === 'unsubscribed') suppressed = true;
      if (recipient.email && records.suppressedEmails.has(recipient.email.trim().toLowerCase())) suppressed = true;
      if (recipient.lead_verdict === 'lead') lead = true;
      if (recipient.lead_verdict === 'not_lead' && recipient.lead_verdict_source === 'manual') closed = true;

      const conversation = conversationByRecipient.get(recipient.id);
      if (conversation?.state === 'handed_off') lead = true;
      if (conversation?.close_reason === 'decline' || conversation?.close_reason === 'counter_offer') closed = true;
      if (conversation?.close_reason === 'stop') suppressed = true;

      for (const reply of repliesByRecipient.get(recipient.id) ?? []) {
        const outcome = classifyCascadeReply(stripQuoted(reply.body ?? ''));
        if (outcome === 'decline') closed = true;
        if (outcome === 'later') laterAt = maxDate(laterAt, toDate(reply.received_at) ?? toDate(reply.created_at));
      }
    }
    items.push({
      row,
      domain,
      inn,
      step: stepOfRow(row),
      lastSentAt: lastSentOfRow(row, sentAt),
      chainRunning,
      lead,
      closed,
      suppressed,
      laterAt,
    });
  }

  // Строки с общим доменом или общим ИНН — одна компания.
  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    let node = i;
    while (parent[node] !== node) {
      parent[node] = parent[parent[node]];
      node = parent[node];
    }
    return node;
  };
  const firstByKey = new Map<string, number>();
  const link = (key: string, i: number) => {
    const first = firstByKey.get(key);
    if (first === undefined) firstByKey.set(key, i);
    else parent[find(i)] = find(first);
  };
  items.forEach((item, i) => {
    if (item.domain) link(`d:${item.domain}`, i);
    if (item.inn) link(`i:${item.inn}`, i);
  });
  const groups = new Map<number, RowFacts[]>();
  items.forEach((item, i) => pushTo(groups, find(i), item));

  const index: CascadeIndex = { byDomain: new Map(), byInn: new Map(), due: [] };
  for (const group of groups.values()) {
    group.sort(compareRows);
    const last = group[group.length - 1];
    const offered: CascadeStep[] = [];
    const facts: CascadeFacts = {
      offered,
      lastSentAt: null,
      chainRunning: false,
      lead: false,
      closed: false,
      suppressed: false,
      laterAt: null,
    };
    for (const item of group) {
      if (!offered.includes(item.step)) offered.push(item.step);
      facts.lastSentAt = maxDate(facts.lastSentAt, item.lastSentAt);
      facts.laterAt = maxDate(facts.laterAt, item.laterAt);
      facts.chainRunning ||= item.chainRunning;
      facts.lead ||= item.lead;
      facts.closed ||= item.closed;
      facts.suppressed ||= item.suppressed;
    }
    // Свежие значения — у последней строки, недостающее берём у предыдущих.
    const newestFirst = [...group].reverse();
    const company: CascadeCompany = {
      domain: newestFirst.find((item) => item.domain)?.domain ?? null,
      inn: newestFirst.find((item) => item.inn)?.inn ?? null,
      lastRowId: last.row.id,
      companyName: newestFirst.find((item) => item.row.company_name)?.row.company_name ?? null,
      signals: [],
      facts,
      decision: cascadeDecision(facts, now, pauseDays),
    };
    for (const item of group) {
      if (item.domain) index.byDomain.set(item.domain, company);
      if (item.inn) index.byInn.set(item.inn, company);
    }
    if (company.decision.kind === 'due') index.due.push(company);
  }
  // Срок «пора писать» = последнее письмо + пауза, у всех одна пауза: порядок по письму.
  index.due.sort(
    (a, b) =>
      (a.facts.lastSentAt?.getTime() ?? 0) - (b.facts.lastSentAt?.getTime() ?? 0) ||
      (a.lastRowId < b.lastRowId ? -1 : 1),
  );
  return index;
}

/** Компания из индекса: сначала по домену, потом по ИНН (тот же ИНН при другом домене — та же компания). */
export function lookupCascade(index: CascadeIndex, domain: string | null, inn: string | null): CascadeCompany | null {
  if (domain) {
    const byDomain = index.byDomain.get(domain);
    if (byDomain) return byDomain;
  }
  if (inn) {
    const byInn = index.byInn.get(inn);
    if (byInn) return byInn;
  }
  return null;
}

// ── Загрузка из базы ────────────────────────────────────────────────────────

interface PageResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

/**
 * Все страницы запроса. Запрос обязан быть упорядочен по уникальному полю:
 * без порядка Postgres отдаёт строки как придётся, и соседние страницы могли бы
 * пропустить или повторить строки.
 */
async function pagedAll<T>(what: string, page: (from: number, to: number) => PromiseLike<PageResult<T>>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(`cascade index: ${what}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

async function runPool<T, R>(items: T[], task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await task(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(POOL, items.length) }, worker));
  return results;
}

/** Запрос с `in`-фильтром по пачкам: длинный список в адресе запроса шлюз режет. */
async function selectByIn<T>(
  what: string,
  values: string[],
  query: (chunk: string[], from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<T[]> {
  const parts = await runPool(chunkForInFilter(values), (chunk) => pagedAll(what, (from, to) => query(chunk, from, to)));
  return parts.flat();
}

const ROW_COLUMNS =
  'id,normalized_domain,inn,company_name,chain_type,product,sender_campaign_id,sender_uploaded_at,created_at,recipient_email,emails';

/**
 * Индекс каскада по прошлым запускам и «Рассылке». `excludeJobId` — текущий
 * запуск: его строки в прошлом не считаются. `pauseDays` — пауза между
 * цепочками из настроек.
 */
export async function loadCascadeIndex(
  db: SupabaseClient,
  excludeJobId: string,
  now: Date,
  pauseDays: number,
): Promise<CascadeIndex> {
  const rows = await pagedAll<RowRecord>('rows', (from, to) =>
    db
      .from('polza_ru_outreach_companies')
      .select(ROW_COLUMNS)
      .eq('row_status', 'ready')
      .neq('job_id', excludeJobId)
      .order('id', { ascending: true })
      .range(from, to),
  );
  const sent = rows.filter(wentOut);

  // Получатели — только из рассылок аутрича: у `ve2` group_key значит другое.
  const campaignIds = [...new Set(sent.map((row) => row.sender_campaign_id).filter((id): id is string => Boolean(id)))];
  const campaigns = await selectByIn<{ id: string; source_kind: string | null }>('campaigns', campaignIds, (chunk, from, to) =>
    db.from('sender_campaigns').select('id,source_kind').in('id', chunk).order('id', { ascending: true }).range(from, to),
  );
  const polzaRuCampaigns = new Set(campaigns.filter((c) => c.source_kind === 'polza_ru').map((c) => c.id));
  const rowIdsByCampaign = new Map<string, string[]>();
  for (const row of sent) {
    if (row.sender_campaign_id && polzaRuCampaigns.has(row.sender_campaign_id)) {
      pushTo(rowIdsByCampaign, row.sender_campaign_id, row.id);
    }
  }
  // Единственный индекс получателей — (campaign_id, group_key): фильтр по обоим.
  const recipientTasks = [...rowIdsByCampaign].flatMap(([campaignId, ids]) =>
    chunkForInFilter(ids).map((chunk) => ({ campaignId, chunk })),
  );
  const recipients = (
    await runPool(recipientTasks, ({ campaignId, chunk }) =>
      pagedAll<RecipientRecord>('recipients', (from, to) =>
        db
          .from('sender_recipients')
          .select('id,email,status,lead_verdict,lead_verdict_source,group_key')
          .eq('campaign_id', campaignId)
          .in('group_key', chunk)
          .order('id', { ascending: true })
          .range(from, to),
      ),
    )
  ).flat();

  const recipientIds = recipients.map((recipient) => recipient.id);
  const messages = await selectByIn<MessageRecord>('messages', recipientIds, (chunk, from, to) =>
    db
      .from('sender_messages')
      .select('recipient_id,sent_at')
      .in('recipient_id', chunk)
      .eq('status', 'sent')
      .order('id', { ascending: true })
      .range(from, to),
  );
  const conversations = await selectByIn<ConversationRecord>('conversations', recipientIds, (chunk, from, to) =>
    db
      .from('sender_ai_conversations')
      .select('recipient_id,state,close_reason')
      .in('recipient_id', chunk)
      .order('recipient_id', { ascending: true })
      .range(from, to),
  );
  const replies = await selectByIn<ReplyRecord>('replies', recipientIds, (chunk, from, to) =>
    db
      .from('sender_replies')
      .select('recipient_id,body,received_at,created_at')
      .in('recipient_id', chunk)
      .eq('kind', 'human')
      .order('id', { ascending: true })
      .range(from, to),
  );

  // Общий стоп-лист «Рассылки». Адрес с жёстким отбоем (hard_bounce) закрывает
  // только себя: компанию он не убирает, раннер сам не возьмёт такой адрес и
  // поищет другой. Отписка, жалоба и ручной стоп — для всей компании.
  // Клиентские стоп-листы кампаний (sender_campaign_suppressions) не читаем.
  const addresses = new Set<string>();
  for (const row of sent) for (const email of rowAddresses(row)) addresses.add(email);
  for (const recipient of recipients) if (recipient.email) addresses.add(recipient.email.trim().toLowerCase());
  const suppressions = await selectByIn<{ email: string; reason: string | null }>('suppressions', [...addresses], (chunk, from, to) =>
    db.from('sender_suppressions').select('email,reason').in('email', chunk).order('email', { ascending: true }).range(from, to),
  );
  const suppressedEmails = new Set(
    suppressions.filter((s) => s.reason !== 'hard_bounce').map((s) => String(s.email).trim().toLowerCase()),
  );

  const index = assembleCascadeIndex(
    { rows: sent, recipients, messages, conversations, replies, suppressedEmails },
    now,
    pauseDays,
  );

  // Сигналы нужны только вернувшимся (решение `due`) — подгружаем у них одних.
  const dueByRow = new Map(index.due.map((company) => [company.lastRowId, company] as const));
  const signalRows = await selectByIn<{ id: string; signals: unknown }>('signals', [...dueByRow.keys()], (chunk, from, to) =>
    db
      .from('polza_ru_outreach_companies')
      .select('id,signals')
      .in('id', chunk)
      .order('id', { ascending: true })
      .range(from, to),
  );
  for (const signalRow of signalRows) {
    const company = dueByRow.get(String(signalRow.id));
    if (company && Array.isArray(signalRow.signals)) company.signals = signalRow.signals as Signal[];
  }
  return index;
}

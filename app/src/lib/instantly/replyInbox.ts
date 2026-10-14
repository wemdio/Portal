// Ответы без вердикта квалификатора для «Персонализированных ответов»
// (instantly_reply_inbox, миграция instantly-migrations/20261007_0001).
//
// Два вида писем, которые квалификатор не берёт, а экран обязан показывать:
//  - наши кампании «N. Polza_…» (см. ownAgencyCampaign.ts) — сборщик ответов
//    видит их на тех же страницах, что читает для квалификатора, и сохраняет
//    здесь без лишних запросов к Instantly;
//  - история кампании, привязанной к проекту позже первых ответов, — её один
//    раз догружает фоновая задача, по странице за проход и в полосе 'bulk'.
//
// До 07.10.2026 экран читал всё это из Instantly при каждом открытии и упирался
// в общий лимит чтения писем: 2177 отказов на 1123 чтения за 3 дня, кампании
// молча показывались пустыми.

import type { SupabaseClient } from '@supabase/supabase-js';
import { listEmails } from './client';
import { readInstantlyEmailReadDeferral } from './emailReadDeferral';
import { isOwnAgencyCampaign } from './ownAgencyCampaign';
import type { Email } from './types';

type InboxDb = Pick<SupabaseClient, 'from'>;

/** За сколько дней привязка считается свежей и её историю догружаем. */
const LINK_HISTORY_DAYS = 30;
/** Страниц истории на кампанию, не больше: 100 страниц — 10 тыс. ответов. */
const MAX_BACKFILL_PAGES = 100;
const BODY_PREVIEW_CHARS = 2000;
const TARGETS_TTL_MS = 60_000;

export interface InboxRow {
  email_id: string;
  account_id: string;
  campaign_id: string;
  thread_id: string | null;
  lead_email: string;
  eaccount: string | null;
  subject: string | null;
  body_preview: string | null;
  reply_timestamp: string | null;
}

function bodyPreview(body: Email['body']): string | null {
  if (!body) return null;
  const text = typeof body === 'string'
    ? body
    : body.text || (body.html ? body.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '');
  return text ? text.slice(0, BODY_PREVIEW_CHARS) : null;
}

/** Входящий ответ кампании → строка; наши письма и письма без кампании — null. */
export function inboxRowOf(email: Email, accountId: string): InboxRow | null {
  if ((email.ue_type ?? 2) !== 2 || !email.id || !email.campaign_id) return null;
  const lead = (email.lead || email.from_address_email || '').trim().toLowerCase();
  if (!lead) return null;
  return {
    email_id: email.id,
    account_id: accountId,
    campaign_id: email.campaign_id,
    thread_id: email.thread_id ?? null,
    lead_email: lead,
    eaccount: (email.eaccount ?? '').trim().toLowerCase() || null,
    subject: email.subject ?? null,
    body_preview: bodyPreview(email.body),
    reply_timestamp: email.timestamp_email ?? email.timestamp_created ?? null,
  };
}

/** Сохраняет ответы; уже сохранённые не трогает. Возвращает, сколько строк отправлено. */
export async function saveInboxRows(db: InboxDb, rows: InboxRow[]): Promise<number> {
  if (!rows.length) return 0;
  const { error } = await db
    .from('instantly_reply_inbox')
    .upsert(rows, { onConflict: 'email_id', ignoreDuplicates: true });
  if (error) throw new Error(`reply inbox save failed: ${error.message}`);
  return rows.length;
}

/**
 * Ответы наших кампаний со страницы, которую сборщик уже прочитал для
 * квалификатора. Ошибка сохранения не должна ронять сбор ответов клиентам.
 */
export async function saveInboxFromPage(
  db: InboxDb,
  emails: Email[],
  accountId: string,
  campaignIds: ReadonlySet<string>,
): Promise<number> {
  if (!campaignIds.size) return 0;
  const rows = emails
    .filter((email) => email.campaign_id && campaignIds.has(email.campaign_id))
    .map((email) => inboxRowOf(email, accountId))
    .filter((row): row is InboxRow => row !== null);
  return saveInboxRows(db, rows);
}

/** Кампания, историю которой догружаем; cutoff — до какой даты (null — вся история). */
export interface InboxTarget {
  campaignId: string;
  cutoff: string | null;
}

let targetsCache: { at: number; own: Set<string>; targets: InboxTarget[] } | null = null;

/**
 * Кампании основного аккаунта для ящика: наши «N. Polza_…», привязанные к
 * проекту (вся история и новые ответы), и кампании, привязанные за последние
 * 30 дней (только ответы до привязки — дальше их берёт квалификатор).
 */
export async function loadInboxTargets(db: InboxDb): Promise<{ own: Set<string>; targets: InboxTarget[] }> {
  if (targetsCache && Date.now() - targetsCache.at < TARGETS_TTL_MS) return targetsCache;
  const [legacy, period] = await Promise.all([
    db.from('project_instantly_campaigns').select('campaign_id, created_at'),
    db.from('project_period_instantly_campaigns').select('campaign_id, created_at'),
  ]);
  if (legacy.error || period.error) {
    throw new Error(`reply inbox links unavailable: ${legacy.error?.message ?? period.error?.message}`);
  }
  const linkedAt = new Map<string, string>();
  for (const row of [...(legacy.data ?? []), ...(period.data ?? [])] as { campaign_id: string | null; created_at: string | null }[]) {
    if (!row.campaign_id || !row.created_at) continue;
    const prev = linkedAt.get(row.campaign_id);
    if (!prev || Date.parse(row.created_at) < Date.parse(prev)) linkedAt.set(row.campaign_id, row.created_at);
  }
  const ids = [...linkedAt.keys()];
  const catalog = new Map<string, { name: string; account: string }>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db
      .from('instantly_campaign_catalog')
      .select('id, name, instantly_account_id')
      .in('id', ids.slice(i, i + 200));
    if (error) throw new Error(`reply inbox catalog unavailable: ${error.message}`);
    for (const row of (data ?? []) as { id: string; name: string | null; instantly_account_id: string | null }[]) {
      catalog.set(row.id, { name: row.name ?? '', account: row.instantly_account_id || 'main' });
    }
  }

  const sinceMs = Date.now() - LINK_HISTORY_DAYS * 24 * 60 * 60_000;
  const own = new Set<string>();
  const targets: InboxTarget[] = [];
  for (const [campaignId, at] of linkedAt) {
    const entry = catalog.get(campaignId);
    // Кампании других аккаунтов экран читает живьём: у них свой лимит, и он не занят.
    if ((entry?.account ?? 'main') !== 'main') continue;
    if (isOwnAgencyCampaign(entry?.name)) {
      own.add(campaignId);
      targets.push({ campaignId, cutoff: null });
    } else if (Date.parse(at) >= sinceMs) {
      targets.push({ campaignId, cutoff: at });
    }
  }
  // Наши — первыми: их ответов на экране нет совсем, у остальных есть свежие.
  targets.sort((a, b) => Number(b.cutoff === null) - Number(a.cutoff === null));
  targetsCache = { at: Date.now(), own, targets };
  return targetsCache;
}

/**
 * Один шаг догрузки истории: одна страница одной недочитанной кампании.
 * Отказ лимита — не ошибка: следующий проход повторит с того же места.
 */
export async function backfillReplyInboxStep(db: InboxDb): Promise<{ campaignId: string; saved: number; done: boolean } | null> {
  const { targets } = await loadInboxTargets(db);
  if (!targets.length) return null;
  const ids = targets.map((t) => t.campaignId);
  const { data: progressRows, error } = await db
    .from('instantly_reply_inbox_backfill')
    .select('campaign_id, cursor, pages, saved, done_at')
    .in('campaign_id', ids);
  if (error) throw new Error(`reply inbox backfill state unavailable: ${error.message}`);
  const progress = new Map(
    ((progressRows ?? []) as { campaign_id: string; cursor: string | null; pages: number; saved: number; done_at: string | null }[])
      .map((row) => [row.campaign_id, row]),
  );
  const target = targets.find((t) => !progress.get(t.campaignId)?.done_at);
  if (!target) return null;
  const state = progress.get(target.campaignId) ?? { cursor: null, pages: 0, saved: 0 };

  let page: Awaited<ReturnType<typeof listEmails>>;
  try {
    page = await listEmails({
      campaign_id: target.campaignId,
      email_type: 'received',
      sort_order: 'desc',
      limit: 100,
      // Только до привязки: у кампании, привязанной сразу после запуска,
      // это одна пустая страница вместо листания всей её переписки.
      max_timestamp_created: target.cutoff ? new Date(target.cutoff).toISOString() : undefined,
      starting_after: state.cursor ?? undefined,
    }, { accountId: 'main', requestPriority: 'bulk', consumer: 'personalization_backfill', timeoutMs: 20_000 });
  } catch (err) {
    if (readInstantlyEmailReadDeferral(err)) return null;
    throw err;
  }

  let rows = (page.items ?? [])
    .map((email) => inboxRowOf(email, 'main'))
    .filter((row): row is InboxRow => row !== null && row.campaign_id === target.campaignId);
  // История до привязки: после неё ответы берёт квалификатор, дубль не нужен.
  if (target.cutoff) {
    const cutoffMs = Date.parse(target.cutoff);
    rows = rows.filter((row) => !row.reply_timestamp || Date.parse(row.reply_timestamp) < cutoffMs);
  }
  if (rows.length) {
    const { data: known, error: knownError } = await db
      .from('instantly_lead_qualifications')
      .select('instantly_email_id')
      .in('instantly_email_id', rows.map((row) => row.email_id));
    if (knownError) throw new Error(`reply inbox dedupe failed: ${knownError.message}`);
    const taken = new Set(((known ?? []) as { instantly_email_id: string | null }[]).map((row) => row.instantly_email_id));
    rows = rows.filter((row) => !taken.has(row.email_id));
  }
  const saved = await saveInboxRows(db, rows);

  const next = page.next_starting_after || null;
  const pages = state.pages + 1;
  const done = !next || !(page.items ?? []).length || pages >= MAX_BACKFILL_PAGES;
  const { error: saveError } = await db.from('instantly_reply_inbox_backfill').upsert({
    campaign_id: target.campaignId,
    account_id: 'main',
    cursor: done ? null : next,
    pages,
    saved: state.saved + saved,
    done_at: done ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'campaign_id' });
  if (saveError) throw new Error(`reply inbox backfill state save failed: ${saveError.message}`);
  return { campaignId: target.campaignId, saved, done };
}

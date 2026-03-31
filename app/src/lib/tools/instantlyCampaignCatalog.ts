import 'server-only';

import type { Campaign } from '@/lib/instantly/types';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getCampaignAnalytics } from '@/lib/instantly/client';
import {
  iterateInstantlyCampaignPages,
  type InstantlyCampaignItem,
} from '@/lib/tools/autoReportBuilder';

/** Порог актуальности каталога (синхронизация ведётся TG-ботом раз в час). */
export const INSTANTLY_CATALOG_STALE_MS = 65 * 60 * 1000;

const NAME_MAX_LEN = 2000;

function sortCampaigns(a: InstantlyCampaignItem, b: InstantlyCampaignItem): number {
  const at = a.timestamp_created ?? a.timestamp_updated ?? '';
  const bt = b.timestamp_created ?? b.timestamp_updated ?? '';
  const an = at ? Date.parse(at) : NaN;
  const bn = bt ? Date.parse(bt) : NaN;
  if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return bn - an;
  if (at && bt && at !== bt) return bt.localeCompare(at);
  return (b.name ?? '').localeCompare(a.name ?? '', 'ru');
}

export function isCatalogStale(lastSyncedAtIso: string | null, nowMs = Date.now()): boolean {
  if (!lastSyncedAtIso) return true;
  const t = Date.parse(lastSyncedAtIso);
  if (!Number.isFinite(t)) return true;
  return nowMs - t > INSTANTLY_CATALOG_STALE_MS;
}

type CatalogRow = {
  id: string;
  name: string;
  status: number | null;
  timestamp_created: string | null;
  timestamp_updated: string | null;
  synced_at: string;
};

/**
 * Читает кэш каталога из БД. Без service role возвращает пусто (вызывающий делает fallback на API).
 */
export async function readInstantlyCampaignCatalog(): Promise<{
  campaigns: InstantlyCampaignItem[];
  lastSyncedAt: string | null;
}> {
  if (!supabaseAdmin) {
    return { campaigns: [], lastSyncedAt: null };
  }

  const PAGE_SIZE = 1000;
  const allRows: CatalogRow[] = [];
  let from = 0;

  for (;;) {
    const { data, error } = await supabaseAdmin
      .from('instantly_campaign_catalog')
      .select('id,name,status,timestamp_created,timestamp_updated,synced_at')
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw new Error(error.message);
    if (!data?.length) break;

    allRows.push(...(data as CatalogRow[]));
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  if (!allRows.length) {
    return { campaigns: [], lastSyncedAt: null };
  }

  let maxSyncMs = 0;
  const campaigns: InstantlyCampaignItem[] = [];

  for (const raw of allRows) {
    if (raw.synced_at) {
      const m = Date.parse(raw.synced_at);
      if (Number.isFinite(m) && m > maxSyncMs) maxSyncMs = m;
    }
    campaigns.push({
      id: raw.id,
      name: raw.name ?? '',
      status: raw.status ?? undefined,
      timestamp_created: raw.timestamp_created ?? undefined,
      timestamp_updated: raw.timestamp_updated ?? undefined,
    });
  }

  campaigns.sort(sortCampaigns);

  return {
    campaigns,
    lastSyncedAt: maxSyncMs > 0 ? new Date(maxSyncMs).toISOString() : null,
  };
}

/**
 * Полная синхронизация с Instantly: постранично upsert, затем удаление строк не из этого прохода.
 */
export async function syncInstantlyCampaignCatalog(apiKey: string): Promise<{
  pages: number;
  rows: number;
}> {
  if (!supabaseAdmin) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY не настроен — синхронизация каталога недоступна');
  }

  const syncMarker = new Date().toISOString();
  let pages = 0;
  let rows = 0;

  for await (const page of iterateInstantlyCampaignPages(apiKey)) {
    pages += 1;
    const batch = page.map((c) => ({
      id: c.id,
      name: String(c.name ?? '').slice(0, NAME_MAX_LEN),
      status: typeof c.status === 'number' ? c.status : null,
      timestamp_created: c.timestamp_created ?? null,
      timestamp_updated: c.timestamp_updated ?? null,
      synced_at: syncMarker,
    }));

    rows += batch.length;
    const { error } = await supabaseAdmin.from('instantly_campaign_catalog').upsert(batch, {
      onConflict: 'id',
    });
    if (error) {
      throw new Error(error.message);
    }
  }

  // Кампании, которых больше нет в Instantly (удалены в UI Instantly или API), исчезают из каталога.
  const { error: delError } = await supabaseAdmin
    .from('instantly_campaign_catalog')
    .delete()
    .lt('synced_at', syncMarker);

  if (delError) {
    throw new Error(delError.message);
  }

  return { pages, rows };
}

/**
 * Запись/обновление одной кампании в каталоге автоотчётов после операций через портал (создание, PATCH, pause/activate).
 * Не бросает — только логирует, чтобы сбой БД не ломал ответ Instantly.
 */
export async function upsertInstantlyCatalogFromCampaign(
  campaign: Pick<Campaign, 'id' | 'name' | 'status'> &
    Partial<Pick<Campaign, 'timestamp_created' | 'timestamp_updated'>>,
): Promise<void> {
  if (!supabaseAdmin) return;

  const row = {
    id: campaign.id,
    name: String(campaign.name ?? '').slice(0, NAME_MAX_LEN),
    status: typeof campaign.status === 'number' ? campaign.status : null,
    timestamp_created: campaign.timestamp_created ?? null,
    timestamp_updated: campaign.timestamp_updated ?? null,
    synced_at: new Date().toISOString(),
  };

  const { error } = await supabaseAdmin.from('instantly_campaign_catalog').upsert(row, {
    onConflict: 'id',
  });
  if (error) {
    console.error('[instantly-catalog] upsert from portal campaign failed', error.message);
  }
}

/**
 * Синхронизирует аналитику всех кампаний из Instantly API в БД.
 * Вызывается воркером раз в час. Использует upsert только по колонкам аналитики —
 * не трогает name/status/timestamps чтобы не конфликтовать с syncInstantlyCampaignCatalog.
 *
 * Нагрузка на БД: один bulk-upsert (не N отдельных запросов).
 */
export async function syncInstantlyCampaignAnalytics(): Promise<{ rows: number }> {
  if (!supabaseAdmin) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY не настроен — синхронизация аналитики недоступна');
  }

  const analyticsData = await getCampaignAnalytics({});
  if (!Array.isArray(analyticsData) || analyticsData.length === 0) {
    return { rows: 0 };
  }

  const syncedAt = new Date().toISOString();

  // Готовим batch: только кампании у которых есть campaign_id
  const batch = analyticsData
    .filter((a) => typeof a.campaign_id === 'string' && a.campaign_id)
    .map((a) => ({
      id: a.campaign_id as string,
      // name нужен для upsert (NOT NULL в таблице) — используем пустую строку как fallback
      // при конфликте по id поле name НЕ перезаписывается (onConflict merge excludes it)
      name: typeof a.campaign_name === 'string' ? a.campaign_name : '',
      emails_sent_count: typeof a.emails_sent_count === 'number' ? a.emails_sent_count : null,
      open_count: typeof a.open_count === 'number' ? a.open_count : null,
      reply_count: typeof a.reply_count === 'number' ? a.reply_count : null,
      new_leads_contacted_count:
        typeof a.new_leads_contacted_count === 'number' ? a.new_leads_contacted_count : null,
      bounced_count: typeof a.bounced_count === 'number' ? a.bounced_count : null,
      unsubscribed_count: typeof a.unsubscribed_count === 'number' ? a.unsubscribed_count : null,
      leads_count: typeof a.leads_count === 'number' ? a.leads_count : null,
      analytics_synced_at: syncedAt,
      synced_at: syncedAt,
    }));

  if (batch.length === 0) return { rows: 0 };

  // Один bulk-upsert — щадящий для БД
  const { error } = await supabaseAdmin
    .from('instantly_campaign_catalog')
    .upsert(batch, {
      onConflict: 'id',
      ignoreDuplicates: false,
    });

  if (error) throw new Error(error.message);

  return { rows: batch.length };
}

/**
 * Читает аналитику кампаний из БД для клиентского портала.
 * Возвращает только кампании из переданного набора ID (allowed set).
 * Один SELECT запрос — не нагружает БД.
 */
export interface CampaignDbRow {
  id: string;
  name: string;
  status: number | null;
  emails_sent_count: number | null;
  open_count: number | null;
  reply_count: number | null;
  new_leads_contacted_count: number | null;
  bounced_count: number | null;
  unsubscribed_count: number | null;
  leads_count: number | null;
  analytics_synced_at: string | null;
}

export async function readCampaignAnalyticsFromDb(allowedIds: string[]): Promise<{
  campaigns: CampaignDbRow[];
  lastSyncedAt: string | null;
}> {
  if (!supabaseAdmin || allowedIds.length === 0) {
    return { campaigns: [], lastSyncedAt: null };
  }

  const { data, error } = await supabaseAdmin
    .from('instantly_campaign_catalog')
    .select(
      'id,name,status,emails_sent_count,open_count,reply_count,new_leads_contacted_count,bounced_count,unsubscribed_count,leads_count,analytics_synced_at',
    )
    .in('id', allowedIds);

  if (error) throw new Error(error.message);
  if (!data?.length) return { campaigns: [], lastSyncedAt: null };

  let maxSyncMs = 0;
  for (const row of data) {
    const t = row.analytics_synced_at ? Date.parse(row.analytics_synced_at as string) : 0;
    if (Number.isFinite(t) && t > maxSyncMs) maxSyncMs = t;
  }

  return {
    campaigns: data as CampaignDbRow[],
    lastSyncedAt: maxSyncMs > 0 ? new Date(maxSyncMs).toISOString() : null,
  };
}

function n(v: number | null | undefined): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

export interface ClientReportResult {
  tableText: string;
  csvText: string;
  rows: (string | number)[][];
  summary: {
    totalCampaigns: number;
    totalContacts: number;
    totalEmailsSent: number;
    totalOpened: number;
    totalReplies: number;
    totalLeads: number;
    totalBounced: number;
    conversion: { openPctAllEmails: string; replyPctByLeads: string };
  };
}

/**
 * Строит отчёт по кампаниям из данных БД — без обращения к Instantly API.
 * Используется клиентским порталом (/api/client/reports).
 */
export function buildClientReport(rows: CampaignDbRow[]): ClientReportResult {
  const totals = { contacts: 0, sent: 0, opened: 0, replies: 0, leads: 0, bounced: 0 };

  const currentDate = new Date().toLocaleDateString('ru-RU');

  let tableText = `Отчёт по email-кампании\nПериод: ${currentDate}\n\n`;
  tableText += `Статистика по кампаниям:\n`;
  tableText += `Название кампании\tКонтактов\tОтправлено писем\tОткрытий\t% открытий\tОтветов\t% ответов\tЛидов\n`;

  const reportRows: (string | number)[][] = [];
  reportRows.push([
    'Дата', 'Кампания', 'Контактов', 'Отправлено писем',
    'Открытий', '% открытий', 'Ответов', '% ответов', 'Браков',
  ]);

  for (const c of rows) {
    const contacts = n(c.new_leads_contacted_count);
    const sent = n(c.emails_sent_count);
    const opened = n(c.open_count);
    const replies = n(c.reply_count);
    const leads = n(c.leads_count);
    const bounced = n(c.bounced_count);

    const openPct = sent > 0 ? (opened / sent * 100).toFixed(1) : '0.0';
    const replyPct = contacts > 0 ? (replies / contacts * 100).toFixed(1) : '0.0';

    tableText += `${c.name}\t${contacts}\t${sent}\t${opened}\t${openPct}%\t${replies}\t${replyPct}%\t${leads}\n`;

    reportRows.push([currentDate, c.name, contacts, sent, opened, `${openPct}%`, replies, `${replyPct}%`, bounced]);

    totals.contacts += contacts;
    totals.sent += sent;
    totals.opened += opened;
    totals.replies += replies;
    totals.leads += leads;
    totals.bounced += bounced;
  }

  const totalOpenPct = totals.sent > 0 ? (totals.opened / totals.sent * 100).toFixed(1) : '0.0';
  const totalReplyPct = totals.contacts > 0 ? (totals.replies / totals.contacts * 100).toFixed(1) : '0.0';

  tableText += `\nОбщая статистика:\n`;
  tableText += `Контактов\t${totals.contacts}\nОтправлено\t${totals.sent}\nОткрытий\t${totals.opened}\t${totalOpenPct}%\nОтветов\t${totals.replies}\t${totalReplyPct}%\nЛидов\t${totals.leads}\nБраков\t${totals.bounced}\n`;

  reportRows.push([
    currentDate, 'ИТОГО', totals.contacts, totals.sent,
    totals.opened, `${totalOpenPct}%`, totals.replies, `${totalReplyPct}%`, totals.bounced,
  ]);

  return {
    tableText,
    csvText: tableText.replace(/\t/g, ';'),
    rows: reportRows,
    summary: {
      totalCampaigns: rows.length,
      totalContacts: totals.contacts,
      totalEmailsSent: totals.sent,
      totalOpened: totals.opened,
      totalReplies: totals.replies,
      totalLeads: totals.leads,
      totalBounced: totals.bounced,
      conversion: { openPctAllEmails: totalOpenPct, replyPctByLeads: totalReplyPct },
    },
  };
}

/** Удаление строки каталога после DELETE кампании через API портала. */
export async function deleteInstantlyCatalogCampaignById(id: string): Promise<void> {
  if (!supabaseAdmin) return;

  const { error } = await supabaseAdmin.from('instantly_campaign_catalog').delete().eq('id', id);
  if (error) {
    console.error('[instantly-catalog] delete by id failed', error.message);
  }
}

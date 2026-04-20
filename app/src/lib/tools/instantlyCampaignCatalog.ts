import 'server-only';

import type { Campaign } from '@/lib/instantly/types';
import { supabaseInstantly as supabaseAdmin } from '@/lib/supabaseInstantly';
import { supabaseAdmin as supabaseMain } from '@/lib/supabaseAdmin';
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

  // Auto-match campaigns to projects by client name
  try {
    const { matched } = await autoMatchCampaignsToProjects();
    if (matched > 0) {
      console.log(`[instantly-catalog] auto-matched ${matched} campaign-project links`);
    }
  } catch (err) {
    console.error('[instantly-catalog] auto-match error (non-fatal)', err);
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

/**
 * AI-powered matching for campaigns that text-based matching missed.
 * Only processes campaigns not yet linked to any project.
 * Uses a cheap model to match campaign names to project clients
 * (handles transliteration, abbreviations, different languages).
 */
async function aiMatchUnmatchedCampaigns(
  projects: { id: string; client: string }[],
  allCampaignIds: Set<string>,
): Promise<{ matched: number }> {
  if (!supabaseAdmin || !supabaseMain) return { matched: 0 };

  const apiKey =
    process.env.OPENROUTER_INSTANTLY_LEAD_API_KEY ??
    process.env.OPENROUTER_BRIEF_API_KEY ??
    '';
  if (!apiKey) return { matched: 0 };

  // Find campaigns not linked to any project yet
  const { data: alreadyLinked } = await supabaseAdmin
    .from('project_instantly_campaigns')
    .select('campaign_id');

  const linkedIds = new Set(
    (alreadyLinked ?? []).map((r: { campaign_id: string }) => r.campaign_id),
  );

  const { data: unmatchedRows } = await supabaseAdmin
    .from('instantly_campaign_catalog')
    .select('id, name')
    .not('name', 'is', null);

  if (!unmatchedRows?.length) return { matched: 0 };

  const unmatched = (unmatchedRows as { id: string; name: string }[])
    .filter((c) => !linkedIds.has(c.id) && allCampaignIds.has(c.id) && c.name.trim().length > 3);

  if (unmatched.length === 0) return { matched: 0 };

  // Process in batches to stay within token limits
  const BATCH_SIZE = 200;
  const projectList = projects.map((p) => `${p.id}|${p.client}`).join('\n');
  let totalMatched = 0;

  for (let i = 0; i < unmatched.length; i += BATCH_SIZE) {
    const batch = unmatched.slice(i, i + BATCH_SIZE);
    const campaignList = batch.map((c) => `${c.id}|${c.name}`).join('\n');

    const prompt = `Match campaigns to projects by client name. Campaigns may use transliteration, abbreviations, or different languages than the project client name.

PROJECTS (id|client):
${projectList}

CAMPAIGNS (id|name):
${campaignList}

Return ONLY a JSON array of matches: [{"project_id":"...","campaign_id":"..."}]
Only include confident matches. If a campaign clearly belongs to a project client, include it. If unsure, skip it.
Return [] if no matches found.`;

    try {
      const response = await fetch('https://router.requesty.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://portal.app',
          'X-Title': 'Portal - Campaign Project Matcher',
        },
        body: JSON.stringify({
          model: 'google/gemini-2.0-flash-001',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
          max_tokens: 4000,
          response_format: { type: 'json_object' },
        }),
      });

      if (!response.ok) {
        console.error(`[ai-match] API ${response.status}`);
        continue;
      }

      const json = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = json.choices?.[0]?.message?.content ?? '';
      let parsed: { project_id: string; campaign_id: string }[] = [];
      try {
        const raw = JSON.parse(content);
        parsed = Array.isArray(raw) ? raw : (raw.matches ?? raw.results ?? []);
      } catch {
        const arrMatch = content.match(/\[[\s\S]*\]/);
        if (arrMatch) {
          try { parsed = JSON.parse(arrMatch[0]); } catch { /* skip */ }
        }
      }

      if (parsed.length === 0) continue;

      // Validate: only allow known project_id and campaign_id values
      const projectIds = new Set(projects.map((p) => p.id));
      const batchCampaignIds = new Set(batch.map((c) => c.id));
      const valid = parsed.filter(
        (m) => projectIds.has(m.project_id) && batchCampaignIds.has(m.campaign_id),
      );

      if (valid.length > 0) {
        const rows = valid.map((m) => ({
          project_id: m.project_id,
          campaign_id: m.campaign_id,
          match_source: 'auto',
        }));

        const { error } = await supabaseAdmin
          .from('project_instantly_campaigns')
          .upsert(rows, { onConflict: 'project_id,campaign_id', ignoreDuplicates: true });

        if (!error) {
          totalMatched += valid.length;
        } else {
          console.error('[ai-match] upsert error:', error.message);
        }
      }
    } catch (err) {
      console.error('[ai-match] error:', err);
    }
  }

  return { matched: totalMatched };
}

/**
 * Auto-match Instantly campaigns to Portal projects by checking if
 * campaign.name contains project.client (case-insensitive).
 * Then uses AI for remaining unmatched campaigns.
 * Only inserts auto matches; manual matches are never overwritten.
 */
export async function autoMatchCampaignsToProjects(): Promise<{ matched: number }> {
  if (!supabaseAdmin || !supabaseMain) return { matched: 0 };

  const { data: projects } = await supabaseMain
    .from('projects')
    .select('id, client')
    .not('client', 'is', null)
    .neq('client', '');

  if (!projects?.length) return { matched: 0 };

  const { data: campaigns } = await supabaseAdmin
    .from('instantly_campaign_catalog')
    .select('id, name');

  if (!campaigns?.length) return { matched: 0 };

  const { data: existingManual } = await supabaseAdmin
    .from('project_instantly_campaigns')
    .select('project_id, campaign_id')
    .eq('match_source', 'manual');

  const manualSet = new Set(
    (existingManual ?? []).map((r: { project_id: string; campaign_id: string }) =>
      `${r.project_id}::${r.campaign_id}`),
  );

  const matches: { project_id: string; campaign_id: string; match_source: string }[] = [];

  for (const project of projects as { id: string; client: string }[]) {
    const clientLower = project.client.trim().toLowerCase();
    if (clientLower.length < 2) continue;

    for (const campaign of campaigns as { id: string; name: string }[]) {
      const campaignLower = (campaign.name ?? '').toLowerCase();
      if (!campaignLower.includes(clientLower)) continue;
      const key = `${project.id}::${campaign.id}`;
      if (manualSet.has(key)) continue;
      matches.push({
        project_id: project.id,
        campaign_id: campaign.id,
        match_source: 'auto',
      });
    }
  }

  let textMatched = 0;
  if (matches.length > 0) {
    const { error } = await supabaseAdmin
      .from('project_instantly_campaigns')
      .upsert(matches, { onConflict: 'project_id,campaign_id', ignoreDuplicates: true });

    if (error) {
      console.error('[instantly-catalog] auto-match campaigns to projects failed', error.message);
    } else {
      textMatched = matches.length;
    }
  }

  // AI-powered matching for campaigns that text matching missed
  const allCampaignIds = new Set((campaigns as { id: string }[]).map((c) => c.id));
  let aiMatched = 0;
  try {
    const aiResult = await aiMatchUnmatchedCampaigns(
      projects as { id: string; client: string }[],
      allCampaignIds,
    );
    aiMatched = aiResult.matched;
    if (aiMatched > 0) {
      console.log(`[instantly-catalog] AI matched ${aiMatched} additional campaign-project links`);
    }
  } catch (err) {
    console.error('[instantly-catalog] AI match error (non-fatal)', err);
  }

  return { matched: textMatched + aiMatched };
}

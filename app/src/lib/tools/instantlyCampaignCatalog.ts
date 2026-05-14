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
 * Грубая транслитерация кириллица → латиница для pre-filter кандидатов.
 * Покрывает 90% реальных случаев в данных (Asti↔Асти, Binant↔Бинант,
 * Cheesmall↔Чизмол, AMAfamily↔АМА и т.п.). Не идеально, но достаточно
 * чтобы попасть в short-list к AI на per-client запросе.
 */
const CYR_TO_LAT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh',
  з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

function transliterate(s: string): string {
  let out = '';
  for (const ch of s.toLowerCase()) out += CYR_TO_LAT[ch] ?? ch;
  return out;
}

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[\s\-_.!'"()«»❗‼️⭕️|/+]/g, '');
}

function tokenizeClient(s: string): Set<string> {
  return new Set(
    transliterate(s)
      .split(/[\s\-_.!"'()«»|/+,:;]+/)
      .map((t) => t.replace(/[^a-z0-9]/g, ''))
      .filter((t) => t.length >= 3),
  );
}

/**
 * AI-powered matching, переписанный с нуля после массового мисматча
 * 14 мая 2026 (104 ложных привязки, типа ProfitAds ← UNIRATE/Wasserjet/...).
 *
 * Ключевые отличия от старой версии:
 *   1. Per-client запрос (не batch all-vs-all). Модель видит ОДИН целевой
 *      client и оценивает каждую кампанию против него. Это убирает
 *      «default bucket»-эффект, когда модель пристраивала кампании
 *      «куда-нибудь».
 *   2. Confidence score (0..1) в ответе. Принимаем только >= 0.85.
 *   3. Pre-filter кандидатов: для одного клиента отдаём AI только те
 *      кампании, где есть НАМЁК на связь — substring/transliteration/
 *      token overlap. Это и быстрее, и снижает шум.
 *   4. Логирование решений в БД (match_confidence + match_reason).
 *   5. match_source различается: 'auto-text' (substring), 'auto-ai' (AI).
 *      Старые 'auto' остаются — backfill не делаем, новые пишем явно.
 */
async function aiMatchUnmatchedCampaigns(
  projects: { id: string; client: string }[],
  allCampaignIds: Set<string>,
  denylistSet: Set<string>,
): Promise<{ matched: number; aiCalls: number }> {
  if (!supabaseAdmin || !supabaseMain) return { matched: 0, aiCalls: 0 };

  const apiKey =
    process.env.OPENROUTER_INSTANTLY_LEAD_API_KEY ??
    process.env.OPENROUTER_BRIEF_API_KEY ??
    '';
  if (!apiKey) return { matched: 0, aiCalls: 0 };

  const CONFIDENCE_THRESHOLD = Number(
    process.env.INSTANTLY_AI_MATCH_THRESHOLD ?? '0.85',
  );
  const MAX_CANDIDATES_PER_CLIENT = 60; // топ-N кандидатов в одном AI запросе

  // 1. Найти кампании, ещё не привязанные ни к какому проекту.
  const { data: alreadyLinked } = await supabaseAdmin
    .from('project_instantly_campaigns')
    .select('campaign_id');
  const linkedIds = new Set(
    (alreadyLinked ?? []).map((r: { campaign_id: string }) => r.campaign_id),
  );

  const { data: catalogRows } = await supabaseAdmin
    .from('instantly_campaign_catalog')
    .select('id, name')
    .not('name', 'is', null);
  const unmatched = (catalogRows as { id: string; name: string }[] | null ?? [])
    .filter(
      (c) =>
        c.name &&
        c.name.trim().length > 3 &&
        !linkedIds.has(c.id) &&
        allCampaignIds.has(c.id),
    );

  if (unmatched.length === 0) return { matched: 0, aiCalls: 0 };

  // Pre-вычисленные «лёгкие» формы для скоринга кандидатов.
  const campaignNormalized = unmatched.map((c) => ({
    id: c.id,
    name: c.name,
    norm: normalizeForMatch(c.name),
    normTranslit: normalizeForMatch(transliterate(c.name)),
    tokens: new Set(
      transliterate(c.name)
        .split(/[\s\-_.!"'()«»|/+,:;]+/)
        .map((t) => t.replace(/[^a-z0-9]/g, ''))
        .filter((t) => t.length >= 3),
    ),
  }));

  let totalMatched = 0;
  let aiCalls = 0;
  const matchesToInsert: {
    project_id: string;
    campaign_id: string;
    match_source: string;
    match_confidence: number;
    match_reason: string;
  }[] = [];

  for (const project of projects) {
    const client = project.client?.trim();
    if (!client || client.length < 2) continue;

    const clientLower = client.toLowerCase();
    const clientNorm = normalizeForMatch(client);
    const clientTokens = tokenizeClient(client);

    // 2. Pre-filter: оставить только кампании, где есть хоть какой-то намёк.
    //    Без этого фильтра отдавать AI 1800 кандидатов на каждого из 96
    //    клиентов — много токенов и много шума.
    const candidates = campaignNormalized
      .filter((c) => {
        if (c.name.toLowerCase().includes(clientLower)) return true;
        if (clientNorm.length >= 3 && c.norm.includes(clientNorm)) return true;
        if (clientNorm.length >= 3 && c.normTranslit.includes(clientNorm)) return true;
        // Token overlap: хотя бы один токен клиента (>=3 симв) есть в campaign tokens
        for (const t of clientTokens) {
          if (c.tokens.has(t)) return true;
        }
        return false;
      })
      .slice(0, MAX_CANDIDATES_PER_CLIENT);

    if (candidates.length === 0) continue;

    // 3. AI-вызов на конкретного клиента.
    const candidateList = candidates.map((c) => `${c.id}|${c.name}`).join('\n');
    const prompt = `You are a strict matcher. Decide which of the listed CAMPAIGNS belong to this CLIENT.

CLIENT: ${client}

CAMPAIGNS (id|name):
${candidateList}

Rules:
- A campaign belongs to this client ONLY if the client's name (or its transliteration / close spelling variant / clear abbreviation) appears explicitly in the campaign name.
- Do NOT match by industry, theme, or generic keyword similarity.
- Do NOT use "default bucket" reasoning. If unsure, skip the campaign.
- Same campaign can only belong to one client; if it could plausibly belong to several different clients (e.g. a generic name), confidence should be low.

Return a JSON object: {"matches": [{"campaign_id": "...", "confidence": 0.0-1.0, "reason": "short explanation"}]}

Confidence semantics:
- 1.00: campaign name explicitly contains the exact client name.
- 0.95: minor variation — case, punctuation, typo, obvious transliteration (e.g. "Profit gateaway" for "Profit-Gateway", "Asti Group" for "Асти Групп").
- 0.85: clear unambiguous abbreviation (e.g. only if no other client could plausibly claim it).
- < 0.85: ambiguous — DO NOT include.

Return {"matches": []} if no confident matches.`;

    try {
      aiCalls++;
      const response = await fetch('https://router.requesty.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://portal.app',
          'X-Title': 'Portal - Campaign Project Matcher (per-client)',
        },
        body: JSON.stringify({
          model: 'google/gemini-2.0-flash-001',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
          max_tokens: 1500,
          response_format: { type: 'json_object' },
        }),
      });

      if (!response.ok) {
        console.error(`[ai-match] API ${response.status} for client "${client}"`);
        continue;
      }

      const json = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = json.choices?.[0]?.message?.content ?? '';
      type AIMatch = { campaign_id: string; confidence: number; reason?: string };
      let parsed: AIMatch[] = [];
      try {
        const raw = JSON.parse(content) as { matches?: AIMatch[] } | AIMatch[];
        parsed = Array.isArray(raw) ? raw : (raw.matches ?? []);
      } catch {
        const objMatch = content.match(/\{[\s\S]*\}/);
        if (objMatch) {
          try {
            const raw = JSON.parse(objMatch[0]) as { matches?: AIMatch[] };
            parsed = raw.matches ?? [];
          } catch {
            /* skip — модель вернула мусор, не валим всю операцию */
          }
        }
      }

      const candidateIds = new Set(candidates.map((c) => c.id));
      for (const m of parsed) {
        if (typeof m.confidence !== 'number') continue;
        if (m.confidence < CONFIDENCE_THRESHOLD) continue;
        if (!candidateIds.has(m.campaign_id)) continue;
        const key = `${project.id}::${m.campaign_id}`;
        if (denylistSet.has(key)) continue;
        matchesToInsert.push({
          project_id: project.id,
          campaign_id: m.campaign_id,
          match_source: 'auto-ai',
          match_confidence: m.confidence,
          match_reason: (m.reason ?? '').slice(0, 200),
        });
      }
    } catch (err) {
      console.error(`[ai-match] error for client "${client}":`, err);
    }
  }

  // Дедуп по campaign_id: одна кампания не может принадлежать двум проектам.
  // Кейс STAPE/Stape (15 мая 2026): у клиента в портале два проекта — один
  // для TG-аутрича, другой для email-аутрича. AI обрабатывает их независимо,
  // и одна и та же кампания получает confidence 0.95 для обоих. Без дедупа
  // мы вставили бы 2 строки в `project_instantly_campaigns` (UNIQUE на
  // (project_id, campaign_id) такие дубли разрешает), что некорректно
  // логически — worker дважды считал бы лиды этой кампании.
  // Стратегия: оставить project с максимальным confidence; при равенстве —
  // алфавитный порядок client name (детерминированно). Специалист всегда
  // может вручную добавить вторую привязку через UI.
  const bestPerCampaign = new Map<string, (typeof matchesToInsert)[number]>();
  const clientByProjectId = new Map(projects.map((p) => [p.id, p.client] as const));
  for (const m of matchesToInsert) {
    const prev = bestPerCampaign.get(m.campaign_id);
    if (!prev) {
      bestPerCampaign.set(m.campaign_id, m);
      continue;
    }
    if (m.match_confidence > prev.match_confidence) {
      bestPerCampaign.set(m.campaign_id, m);
    } else if (m.match_confidence === prev.match_confidence) {
      const a = clientByProjectId.get(m.project_id) ?? '';
      const b = clientByProjectId.get(prev.project_id) ?? '';
      if (a.localeCompare(b) < 0) bestPerCampaign.set(m.campaign_id, m);
    }
  }
  const dedupedMatches = [...bestPerCampaign.values()];
  if (dedupedMatches.length < matchesToInsert.length) {
    console.log(
      `[ai-match] dedup by campaign_id: ${matchesToInsert.length} → ${dedupedMatches.length}`,
    );
  }

  if (dedupedMatches.length > 0) {
    const { error } = await supabaseAdmin
      .from('project_instantly_campaigns')
      .upsert(dedupedMatches, {
        onConflict: 'project_id,campaign_id',
        ignoreDuplicates: true,
      });
    if (error) {
      console.error('[ai-match] upsert error:', error.message);
    } else {
      totalMatched = dedupedMatches.length;
      // Чтобы постфактум можно было ревьюить — пишем краткий лог в stdout.
      // Например: «[ai-match] auto-ai: Profit-Gateway ← campaign-uuid 0.95
      // "Profit gateaway = transliteration of Profit Gateway"»
      const previewN = Math.min(10, dedupedMatches.length);
      for (const m of dedupedMatches.slice(0, previewN)) {
        const project = projects.find((p) => p.id === m.project_id);
        console.log(
          `[ai-match] ${(project?.client ?? '?').slice(0, 30)} ← ${m.campaign_id.slice(0, 8)}… conf=${m.match_confidence.toFixed(2)} "${m.match_reason.slice(0, 80)}"`,
        );
      }
      if (dedupedMatches.length > previewN) {
        console.log(`[ai-match] ... +${dedupedMatches.length - previewN} more matches`);
      }
    }
  }

  return { matched: totalMatched, aiCalls };
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

  // Чёрный список ручных удалений — кампании, которые специалист отвязал
  // от проекта в карточке. Без этого фильтра text-match при каждом прогоне
  // возвращает их обратно — главная боль продлеваемых проектов, где
  // кампании прошлого периода не должны подтягиваться к новому.
  const { data: denylist } = await supabaseAdmin
    .from('project_instantly_campaigns_denylist')
    .select('project_id, campaign_id');

  const denylistSet = new Set<string>(
    (denylist ?? []).map((r: { project_id: string; campaign_id: string }) =>
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
      if (denylistSet.has(key)) continue;
      matches.push({
        project_id: project.id,
        campaign_id: campaign.id,
        match_source: 'auto-text',
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

  // AI-powered matching for campaigns that text matching missed.
  // См. aiMatchUnmatchedCampaigns — per-client с confidence threshold 0.85.
  const allCampaignIds = new Set((campaigns as { id: string }[]).map((c) => c.id));
  let aiMatched = 0;
  let aiCalls = 0;
  try {
    const aiResult = await aiMatchUnmatchedCampaigns(
      projects as { id: string; client: string }[],
      allCampaignIds,
      denylistSet,
    );
    aiMatched = aiResult.matched;
    aiCalls = aiResult.aiCalls;
  } catch (err) {
    console.error('[instantly-catalog] AI match error (non-fatal)', err);
  }

  console.log(
    `[instantly-catalog] match summary: text=${textMatched} ai=${aiMatched} (in ${aiCalls} AI calls)`,
  );

  return { matched: textMatched + aiMatched };
}

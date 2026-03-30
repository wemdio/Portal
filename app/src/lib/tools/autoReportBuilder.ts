/**
 * Auto-report builder for Instantly email campaigns.
 * Port of n8n pipeline: fetch analytics + steps, normalize (Code3), aggregate (Code1).
 */

const INSTANTLY_BASE = 'https://api.instantly.ai/api/v2';
/** Таймаут одного запроса к Instantly (увеличен для списка кампаний при медленной сети). */
const INSTANTLY_TIMEOUT_MS = 90_000;
const INSTANTLY_MAX_RETRIES = 3;
/** Задержка между кампаниями (мс) — не перегружать Instantly API при большом кол-ве кампаний. */
const INTER_CAMPAIGN_DELAY_MS = 350;

const UUID_PATTERN = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi;

export interface InstantlyCampaignItem {
  id: string;
  name: string;
  status?: number;
  timestamp_created?: string;
  timestamp_updated?: string;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number) {
  return status === 429 || status >= 500;
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function fetchInstantlyJson(
  url: string,
  headers: HeadersInit,
  context: string,
): Promise<unknown> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= INSTANTLY_MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), INSTANTLY_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      if (res.ok) {
        return (await res.json()) as unknown;
      }

      const body = await res.text().catch(() => '');
      if (attempt < INSTANTLY_MAX_RETRIES && isRetryableStatus(res.status)) {
        const backoff = res.status === 429 ? 5000 : 2000;
        await sleep(backoff * (attempt + 1));
        continue;
      }

      const cleanBody = body.includes('<html') ? `${res.status} Bad Gateway` : body.slice(0, 400);
      throw new Error(
        `${context} failed: ${res.status}${cleanBody ? ` ${cleanBody}` : ''}`,
      );
    } catch (err) {
      lastError = err;
      const message = getErrorMessage(err);
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      const isNetwork = /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(message);
      if (attempt < INSTANTLY_MAX_RETRIES && (isTimeout || isNetwork)) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      break;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  const msg = getErrorMessage(lastError);
  const isAborted = /aborted|AbortError/i.test(msg) || (lastError instanceof Error && lastError.name === 'AbortError');
  if (isAborted) {
    throw new Error(
      `${context} failed: запрос отменён по таймауту или обрыву сети. Проверьте доступ к api.instantly.ai и попробуйте ещё раз.`,
    );
  }
  throw new Error(`${context} failed: ${msg}`);
}

function extractCampaignsArray(data: unknown): InstantlyCampaignItem[] | null {
  if (Array.isArray(data)) return data as InstantlyCampaignItem[];
  if (!data || typeof data !== 'object') return null;
  const o = data as Record<string, unknown>;
  // Официальный формат List campaign: { items: Campaign[], next_starting_after?: string }
  if (Array.isArray(o.items)) return o.items as InstantlyCampaignItem[];
  if (Array.isArray(o.campaigns)) return o.campaigns as InstantlyCampaignItem[];
  if (Array.isArray(o.body)) return o.body as InstantlyCampaignItem[];
  if (o.body && typeof o.body === 'object' && Array.isArray((o.body as Record<string, unknown>).campaigns)) {
    return (o.body as { campaigns: InstantlyCampaignItem[] }).campaigns;
  }
  if (Array.isArray(o.data)) return o.data as InstantlyCampaignItem[];
  return null;
}

/**
 * Постраничная выборка списка кампаний Instantly (API v2), по 100 штук.
 * Используется синхронизацией каталога в БД и полным списком в fallback-режиме.
 */
export async function* iterateInstantlyCampaignPages(
  apiKey: string,
): AsyncGenerator<InstantlyCampaignItem[], void, void> {
  const headers: HeadersInit = { Authorization: `Bearer ${apiKey}` };
  let startingAfter: string | null = null;
  const seenPageTokens = new Set<string>();
  let pageCount = 0;

  do {
    const url = new URL(`${INSTANTLY_BASE}/campaigns`);
    url.searchParams.set('limit', '100');
    if (startingAfter) url.searchParams.set('starting_after', startingAfter);

    const tokenKey = startingAfter ?? '__first__';
    if (seenPageTokens.has(tokenKey)) break;
    seenPageTokens.add(tokenKey);
    pageCount += 1;
    if (pageCount > 200) break;

    const data = await fetchInstantlyJson(url.toString(), headers, 'Instantly list campaigns');
    const arr = extractCampaignsArray(data);
    if (arr?.length) yield arr;

    const next = data && typeof data === 'object' && (data as Record<string, unknown>).next_starting_after;
    startingAfter = typeof next === 'string' && next ? next : null;
  } while (startingAfter);
}

/**
 * Список кампаний Instantly (API v2).
 * GET /api/v2/campaigns — ответ: { items: Campaign[], next_starting_after?: string }.
 * Авторизация: Bearer {{api_key}} в заголовке Authorization.
 * Поддержана пагинация (limit=100, starting_after).
 */
export async function fetchInstantlyCampaignsList(apiKey: string): Promise<InstantlyCampaignItem[]> {
  const all: InstantlyCampaignItem[] = [];
  for await (const page of iterateInstantlyCampaignPages(apiKey)) {
    all.push(...page);
  }
  return all;
}

export function extractCampaignIdsFromText(text: string): string[] {
  const matches = text.match(UUID_PATTERN);
  if (!matches?.length) return [];
  return [...new Set(matches)];
}

export async function fetchInstantlyCampaignData(
  campaignId: string,
  apiKey: string
): Promise<{ analytics: unknown; steps: unknown }> {
  const headers: HeadersInit = {
    Authorization: `Bearer ${apiKey}`,
  };

  const analyticsUrl =
    `${INSTANTLY_BASE}/campaigns/analytics?id=${encodeURIComponent(campaignId)}&expand_crm_events=true`;
  const stepsUrl =
    `${INSTANTLY_BASE}/campaigns/analytics/steps?campaign_id=${encodeURIComponent(campaignId)}`;

  const analytics = await fetchInstantlyJson(analyticsUrl, headers, 'Instantly analytics');
  await sleep(200);
  const steps = await fetchInstantlyJson(stepsUrl, headers, 'Instantly steps');
  return { analytics, steps };
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function variantToLetter(variantIndex: unknown): string {
  return String.fromCharCode(65 + (parseInt(String(variantIndex), 10) || 0));
}

// ---------- Code3: normalize body ----------
function unwrapBody(body: unknown): unknown {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') return body;
  return null;
}

function isDetailsArray(arr: unknown): arr is Record<string, unknown>[] {
  if (!Array.isArray(arr)) return false;
  const first = arr[0] as Record<string, unknown> | undefined;
  if (!first) return false;
  return (
    typeof first.step !== 'undefined' ||
    typeof first.variant !== 'undefined' ||
    typeof first.sent !== 'undefined' ||
    typeof first.unique_opened !== 'undefined' ||
    typeof first.unique_replies !== 'undefined' ||
    typeof first.opened !== 'undefined' ||
    typeof first.replies !== 'undefined'
  );
}

function isSummaryObject(obj: unknown): obj is Record<string, unknown> {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o.campaign_id !== 'undefined' ||
    typeof o.campaign_name !== 'undefined' ||
    typeof o.emails_sent_count !== 'undefined' ||
    typeof o.open_count !== 'undefined' ||
    typeof o.reply_count !== 'undefined' ||
    typeof o.open_count_unique !== 'undefined' ||
    typeof o.contacted_count !== 'undefined' ||
    typeof o.new_leads_contacted_count !== 'undefined' ||
    typeof o.leads_count !== 'undefined'
  );
}

function detectType(body: unknown): 'details' | 'summary-array' | 'summary-object' | 'unknown-array' | 'unknown' {
  if (Array.isArray(body)) {
    if (isDetailsArray(body)) return 'details';
    const first = (body as unknown[])[0] as Record<string, unknown> | undefined;
    if (first && isSummaryObject(first)) return 'summary-array';
    return 'unknown-array';
  }
  if (isSummaryObject(body)) return 'summary-object';
  return 'unknown';
}

interface NormalizedItem {
  body: unknown;
  _meta: { type: string; sourceIndex: number };
}

function normalizeMergeItems(items: { body?: unknown; [k: string]: unknown }[]): NormalizedItem[] {
  return items.map((item, idx) => {
    const j = item as Record<string, unknown>;
    const bodyCandidate = typeof j.body !== 'undefined' ? j.body : j;
    const body = unwrapBody(bodyCandidate);
    const t = detectType(body);

    if (t === 'summary-array') {
      const arr = body as unknown[];
      const first = arr?.[0] ?? {};
      return { body: first, _meta: { type: 'summary', sourceIndex: idx } };
    }
    if (t === 'summary-object') {
      return { body, _meta: { type: 'summary', sourceIndex: idx } };
    }
    if (t === 'details') {
      return { body, _meta: { type: 'details', sourceIndex: idx } };
    }
    return {
      body: body ?? (j.body ?? j),
      _meta: { type: 'unknown', sourceIndex: idx },
    };
  });
}

// ---------- Code1: campaign data models ----------
interface CampaignStep {
  stepName: string;
  totalSent: number;
  totalOpened: number;
  totalReplied: number;
  totalClicked: number;
  totalOpportunities: number;
  variants: Record<
    string,
    { letter: string; sent: number; opened: number; replied: number; clicked: number; opportunities: number }
  >;
}

interface CampaignRecord {
  name: string;
  contacts: number;
  opened: number;
  replies: number;
  leads: number;
  bounced: number;
  totalEmailsSent: number;
  steps: Record<number, CampaignStep>;
}

interface TotalStats {
  contacts: number;
  opened: number;
  replies: number;
  leads: number;
  sent: number;
  bounced: number;
}

function buildReportFromNormalized(normalized: NormalizedItem[]): {
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
  campaignData: Record<string, CampaignRecord>;
} {
  const detailsData: { index: number; data: unknown[] }[] = [];
  const newSummaryData: { index: number; data: Record<string, unknown> }[] = [];

  normalized.forEach((item, index) => {
    const b = item.body;
    if (Array.isArray(b)) {
      const first = b[0] as Record<string, unknown> | undefined;
      const looksLikeDetails =
        first &&
        (typeof first.step !== 'undefined' ||
          typeof first.variant !== 'undefined' ||
          typeof first.sent !== 'undefined' ||
          typeof first.unique_opened !== 'undefined' ||
          typeof first.unique_replies !== 'undefined');
      const looksLikeSummary =
        first &&
        (typeof first.campaign_id !== 'undefined' ||
          typeof first.campaign_name !== 'undefined' ||
          typeof first.emails_sent_count !== 'undefined' ||
          typeof first.open_count !== 'undefined' ||
          typeof first.reply_count !== 'undefined' ||
          typeof first.new_leads_contacted_count !== 'undefined');
      if (looksLikeSummary && !looksLikeDetails) {
        newSummaryData.push({ index, data: first });
      } else {
        detailsData.push({ index, data: b as unknown[] });
      }
      return;
    }
    if (b && typeof b === 'object' && !Array.isArray(b)) {
      const o = b as Record<string, unknown>;
      if (
        typeof o.campaign_id !== 'undefined' ||
        typeof o.campaign_name !== 'undefined' ||
        typeof o.emails_sent_count !== 'undefined' ||
        typeof o.open_count !== 'undefined' ||
        typeof o.reply_count !== 'undefined' ||
        typeof o.new_leads_contacted_count !== 'undefined'
      ) {
        newSummaryData.push({ index, data: o });
      }
      return;
    }
  });

  const campaignData: Record<string, CampaignRecord> = {};
  const totalStats: TotalStats = {
    contacts: 0,
    opened: 0,
    replies: 0,
    leads: 0,
    sent: 0,
    bounced: 0,
  };

  newSummaryData.forEach((wrap, idx) => {
    const s = wrap.data;
    const campaignName = (s.campaign_name as string) || `Campaign ${idx + 1}`;
    const contacts = num(s.new_leads_contacted_count);
    const opened = num(s.open_count);
    const replies = num(s.reply_count);
    const sent = num(s.emails_sent_count);
    const leads = num(s.leads_count);
    const bounced = num(s.bounced_count);
    const campaignKey = `campaign_${Object.keys(campaignData).length + 1}`;
    campaignData[campaignKey] = {
      name: campaignName,
      contacts,
      opened,
      replies,
      leads,
      bounced,
      totalEmailsSent: sent,
      steps: {},
    };
  });

  detailsData.forEach((detailItem, idx) => {
    const campaignKey = `campaign_${idx + 1}`;
    if (!campaignData[campaignKey]) {
      campaignData[campaignKey] = {
        name: `Campaign ${idx + 1}`,
        contacts: 0,
        opened: 0,
        replies: 0,
        leads: 0,
        bounced: 0,
        totalEmailsSent: 0,
        steps: {},
      };
    }
    const dataArr = detailItem.data as Record<string, unknown>[];
    dataArr.forEach((dataItem) => {
      const stepNumber = (parseInt(String(dataItem.step), 10) || 0) + 1;
      const variantLetter = variantToLetter(dataItem.variant);
      if (!campaignData[campaignKey].steps[stepNumber]) {
        campaignData[campaignKey].steps[stepNumber] = {
          stepName: `Step ${stepNumber}`,
          totalSent: 0,
          totalOpened: 0,
          totalReplied: 0,
          totalClicked: 0,
          totalOpportunities: 0,
          variants: {},
        };
      }
      const variantData = {
        letter: variantLetter,
        sent: num(dataItem.sent),
        opened: num(dataItem.unique_opened ?? dataItem.opened),
        replied: num(dataItem.unique_replies ?? dataItem.replies),
        clicked: num(dataItem.unique_clicks ?? dataItem.clicks),
        opportunities: num(dataItem.opportunities),
      };
      campaignData[campaignKey].steps[stepNumber].variants[variantLetter] = variantData;
      const step = campaignData[campaignKey].steps[stepNumber];
      step.totalSent += variantData.sent;
      step.totalOpened += variantData.opened;
      step.totalReplied += variantData.replied;
      step.totalClicked += variantData.clicked;
      step.totalOpportunities += variantData.opportunities;
    });
  });

  Object.values(campaignData).forEach((c) => {
    totalStats.contacts += num(c.contacts);
    totalStats.opened += num(c.opened);
    totalStats.replies += num(c.replies);
    totalStats.leads += num(c.leads);
    totalStats.sent += num(c.totalEmailsSent);
    totalStats.bounced += num(c.bounced);
  });

  const currentDate = new Date().toLocaleDateString('ru-RU');
  const period = `с ${currentDate} по ${currentDate}`;

  let tableText = `Отчёт по email-кампании\n`;
  tableText += `Период: ${period}\n\n`;
  tableText += `Статистика по кампаниям:\n`;
  tableText += `Название кампании\tКонтактов\tОтправлено писем\tОткрытий\t% открытий всех писем\tОтветов\t% ответов\tЛидов\tОстаток базы\n`;

  Object.values(campaignData).forEach((c) => {
    const contacts = num(c.contacts);
    const sent = num(c.totalEmailsSent);
    const opened = num(c.opened);
    const replies = num(c.replies);
    const leads = num(c.leads);
    const openRate = sent > 0 ? (opened / sent * 100).toFixed(1) : '0.0';
    const replyRate = contacts > 0 ? (replies / contacts * 100).toFixed(1) : '0.0';
    const remainingBase = Math.max(0, leads - contacts);
    tableText += `${c.name}\t${contacts}\t${sent}\t${opened}\t${openRate}%\t${replies}\t${replyRate}%\t${leads}\t${remainingBase}\n`;
  });

  const totalOpenPct =
    totalStats.sent > 0 ? (totalStats.opened / totalStats.sent * 100).toFixed(1) : '0.0';
  const totalReplyPct =
    totalStats.contacts > 0 ? (totalStats.replies / totalStats.contacts * 100).toFixed(1) : '0.0';

  tableText += `\nОбщая статистика:\n`;
  tableText += `Показатель\tЗначение\tПроцент\n`;
  tableText += `Общее количество контактов\t${totalStats.contacts}\t\n`;
  tableText += `Общее количество отправленных писем\t${totalStats.sent}\t\n`;
  tableText += `Общее количество открытий\t${totalStats.opened}\t${totalOpenPct}%\n`;
  tableText += `Общее количество ответов\t${totalStats.replies}\t${totalReplyPct}%\n`;
  tableText += `Общее количество лидов\t${totalStats.leads}\t\n`;
  tableText += `Общее количество бракованных\t${totalStats.bounced}\t\n`;

  tableText += `\nДетализация по письмам:\n\n`;
  Object.values(campaignData).forEach((c) => {
    tableText += `${c.name}\n`;
    tableText += `STEP\tSENT\tOPENED\tREPLIED\tCLICKED\tOPPORTUNITIES\n`;
    if (Object.keys(c.steps).length === 0) {
      const openRate =
        c.totalEmailsSent > 0 ? (num(c.opened) / num(c.totalEmailsSent) * 100).toFixed(1) : '0.0';
      const replyRate = num(c.contacts) > 0 ? (num(c.replies) / num(c.contacts) * 100).toFixed(1) : '0.0';
      tableText += `Общая статистика\t${num(c.totalEmailsSent)}\t${num(c.opened)}|${openRate}%\t${num(c.replies)}|${replyRate}%\t0\t0\n\n`;
      return;
    }
    const sortedSteps = Object.keys(c.steps).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    sortedSteps.forEach((stepNumber) => {
      const step = c.steps[Number(stepNumber)];
      const stepOpenRate =
        step.totalSent > 0 ? (step.totalOpened / step.totalSent * 100).toFixed(1) : '0.0';
      const stepReplyRate =
        step.totalSent > 0 ? (step.totalReplied / step.totalSent * 100).toFixed(1) : '0.0';
      tableText += `${step.stepName}\t${step.totalSent}\t${step.totalOpened}|${stepOpenRate}%\t${step.totalReplied}|${stepReplyRate}%\t${step.totalClicked}\t${step.totalOpportunities}\n`;
      const sortedVariants = Object.keys(step.variants).sort();
      sortedVariants.forEach((letter) => {
        const v = step.variants[letter];
        const vOpen = v.sent > 0 ? (v.opened / v.sent * 100).toFixed(0) : '0';
        const vReply = v.sent > 0 ? (v.replied / v.sent * 100).toFixed(0) : '0';
        tableText += `${letter}\t${v.sent}\t${v.opened}|${vOpen}%\t${v.replied}|${vReply}%\t${v.clicked}\t${v.opportunities}\n`;
      });
      tableText += `\n`;
    });
  });

  const csvText = tableText.replace(/\t/g, ';');

  const rows: (string | number)[][] = [];
  rows.push([
    'Дата',
    'Кампания',
    'Контактов',
    'Отправлено писем',
    'Открытий',
    '% открытий всех писем',
    'Ответов',
    '% ответов',
    'Браков',
  ]);
  Object.values(campaignData).forEach((c) => {
    const contacts = num(c.contacts);
    const sent = num(c.totalEmailsSent);
    const opened = num(c.opened);
    const replies = num(c.replies);
    const bounced = num(c.bounced);
    const openRate = sent > 0 ? (opened / sent * 100).toFixed(1) : '0.0';
    const replyRate = contacts > 0 ? (replies / contacts * 100).toFixed(1) : '0.0';
    rows.push([
      currentDate,
      c.name,
      contacts,
      sent,
      opened,
      `${openRate}%`,
      replies,
      `${replyRate}%`,
      bounced,
    ]);
  });
  rows.push([
    currentDate,
    'ИТОГО',
    totalStats.contacts,
    totalStats.sent,
    totalStats.opened,
    `${totalOpenPct}%`,
    totalStats.replies,
    `${totalReplyPct}%`,
    totalStats.bounced,
  ]);

  return {
    tableText,
    csvText,
    rows,
    summary: {
      totalCampaigns: Object.keys(campaignData).length,
      totalContacts: totalStats.contacts,
      totalEmailsSent: totalStats.sent,
      totalOpened: totalStats.opened,
      totalReplies: totalStats.replies,
      totalLeads: totalStats.leads,
      totalBounced: totalStats.bounced,
      conversion: {
        openPctAllEmails: totalOpenPct,
        replyPctByLeads: totalReplyPct,
      },
    },
    campaignData,
  };
}

/**
 * Fetch data for each campaign from Instantly, then build the report.
 */
export async function buildAutoReport(
  campaignIds: string[],
  apiKey: string
): Promise<{
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
  campaignData: Record<string, CampaignRecord>;
}> {
  if (!campaignIds.length) {
    throw new Error('Не указаны ID кампаний');
  }
  if (!apiKey.trim()) {
    throw new Error('Не настроен INSTANTLY_API_KEY или INSTANTLY_PORTAL_API_KEY');
  }

  const mergeItems: { body?: unknown }[] = [];
  const failedCampaigns: string[] = [];

  for (let i = 0; i < campaignIds.length; i++) {
    const id = campaignIds[i];
    try {
      const { analytics, steps } = await fetchInstantlyCampaignData(id, apiKey);
      const analyticsBody = (analytics as { body?: unknown }).body ?? analytics;
      const stepsBody = (steps as { body?: unknown }).body ?? steps;
      mergeItems.push({ body: analyticsBody });
      mergeItems.push({ body: stepsBody });
    } catch (err) {
      console.error(`[auto-report] Skipping campaign ${id}: ${getErrorMessage(err)}`);
      failedCampaigns.push(id);
    }

    if (i < campaignIds.length - 1) {
      await sleep(INTER_CAMPAIGN_DELAY_MS);
    }
  }

  if (mergeItems.length === 0) {
    const reason = failedCampaigns.length > 0
      ? `Все ${failedCampaigns.length} кампании не загрузились. Instantly API возвращает ошибки (502/таймаут). Попробуйте позже или выберите меньше кампаний.`
      : 'Нет данных для отчёта';
    throw new Error(reason);
  }

  const normalized = normalizeMergeItems(mergeItems as { body?: unknown; [k: string]: unknown }[]);
  const report = buildReportFromNormalized(normalized);

  if (failedCampaigns.length > 0) {
    const note = `\n⚠ ${failedCampaigns.length} из ${campaignIds.length} кампаний не загрузились (Instantly API вернул ошибку). Отчёт сформирован по остальным.`;
    report.tableText = note + '\n' + report.tableText;
  }

  return report;
}

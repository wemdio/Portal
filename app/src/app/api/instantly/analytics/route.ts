import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import * as instantly from '@/lib/instantly/client';
import { supabaseInstantly } from '@/lib/supabaseInstantly';

export const dynamic = 'force-dynamic';

type AnalyticsRow = {
  id: string;
  name: string;
  emails_sent_count: number | null;
  open_count: number | null;
  reply_count: number | null;
  bounced_count: number | null;
  new_leads_contacted_count: number | null;
  unsubscribed_count: number | null;
  leads_count: number | null;
  analytics_synced_at: string | null;
};

const ANALYTICS_COLS =
  'id,name,emails_sent_count,open_count,reply_count,bounced_count,new_leads_contacted_count,unsubscribed_count,leads_count,analytics_synced_at';

type DataSource = 'db' | 'api' | 'db-fallback';

function toNum(v: number | null | undefined): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function rowToAnalytics(row: AnalyticsRow) {
  return {
    campaign_id: row.id,
    campaign_name: row.name,
    emails_sent_count: toNum(row.emails_sent_count),
    open_count: toNum(row.open_count),
    reply_count: toNum(row.reply_count),
    bounced_count: toNum(row.bounced_count),
    new_leads_contacted_count: toNum(row.new_leads_contacted_count),
    unsubscribed_count: toNum(row.unsubscribed_count),
    leads_count: toNum(row.leads_count),
  };
}

/**
 * Read analytics rows from `instantly_campaign_catalog` and compute the
 * freshest `analytics_synced_at` across them so the caller can decide whether
 * to warn about stale data.
 */
async function readAnalyticsFromDb(
  db: SupabaseClient,
  campaignId?: string,
): Promise<{ items: ReturnType<typeof rowToAnalytics>[]; freshness: string | null }> {
  let query = db.from('instantly_campaign_catalog').select(ANALYTICS_COLS);
  if (campaignId) query = query.eq('id', campaignId);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as unknown as AnalyticsRow[];
  const freshness = rows.reduce<string | null>((max, r) => {
    const ts = r.analytics_synced_at ?? null;
    if (!ts) return max;
    if (!max || ts > max) return ts;
    return max;
  }, null);

  return { items: rows.map(rowToAnalytics), freshness };
}

/**
 * Build a JSON response and tag it with `X-Data-Source` / `X-Data-Freshness`
 * so the analyzer UI can render a "stale data" banner without changing the
 * body shape (kept as a flat array for backward compatibility with other
 * consumers).
 */
function jsonWithSource<T>(
  body: T,
  source: DataSource,
  freshness?: string | null,
  apiError?: string,
): NextResponse {
  const res = NextResponse.json(body);
  res.headers.set('X-Data-Source', source);
  if (freshness) res.headers.set('X-Data-Freshness', freshness);
  if (apiError) res.headers.set('X-Api-Error', apiError);
  return res;
}

function normalizeApiList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const data = (raw as { data?: unknown })?.data;
  return Array.isArray(data) ? data : [];
}

/**
 * Instantly bulk-аналитика (/campaigns/analytics) на воркспейсах с >1000
 * кампаний даёт sporadic 5xx и сообщения «Unable to count leads». Retry
 * с экспоненциальной задержкой кардинально уменьшает частоту падения
 * в db-fallback с устаревшими данными.
 *
 * Не ретраим клиентские 4xx (400, 401, 403) — они стабильны и retry
 * лишь даст лишний latency.
 */
async function getCampaignAnalyticsWithRetry(
  params: { campaign_id?: string },
  maxAttempts = 3,
): Promise<unknown> {
  // Базовая задержка retry. В проде дефолт 1000ms (экспонента → 1s, 2s).
  // В тестах ставим '0' через INSTANTLY_ANALYTICS_RETRY_BASE_MS — иначе
  // один тест-кейс «Instantly stably failing» висит 3+ секунды.
  const baseMs = Number(process.env.INSTANTLY_ANALYTICS_RETRY_BASE_MS ?? '1000');
  let lastErr: unknown = new Error('unreachable');
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await instantly.getCampaignAnalytics(params);
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      // Грубая эвристика: код 5xx, "unable to count", "timeout", "ECONN*" → retry.
      // Всё остальное (4xx, валидация) — fail fast.
      const retriable =
        /\b5\d\d\b/.test(msg) ||
        /unable to count/i.test(msg) ||
        /timeout|ETIMEDOUT|ECONN|fetch failed/i.test(msg);
      if (!retriable || attempt === maxAttempts - 1) throw err;
      const wait = baseMs * Math.pow(2, attempt); // 1s, 2s по дефолту
      console.warn(
        `[instantly-analytics] retry ${attempt + 1}/${maxAttempts} after ${wait}ms: ${msg.slice(0, 120)}`,
      );
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

export const GET = withAuth(async (req) => {
  const url = new URL(req.url);
  const type = url.searchParams.get('type') ?? 'campaigns';
  const campaign_id = url.searchParams.get('campaign_id') ?? undefined;
  const start_date = url.searchParams.get('start_date') ?? undefined;
  const end_date = url.searchParams.get('end_date') ?? undefined;
  const source = url.searchParams.get('source');
  const useDb = source !== 'api';

  switch (type) {
    case 'overview': {
      if (useDb && supabaseInstantly) {
        try {
          let query = supabaseInstantly
            .from('instantly_campaign_catalog')
            .select(ANALYTICS_COLS);

          if (campaign_id) query = query.eq('id', campaign_id);

          const { data, error } = await query;
          if (error) throw new Error(error.message);

          const rows = (data ?? []) as unknown as AnalyticsRow[];
          let totalSent = 0, totalOpened = 0, totalReplied = 0, totalBounced = 0, totalLeads = 0;
          for (const row of rows) {
            totalSent += toNum(row.emails_sent_count);
            totalOpened += toNum(row.open_count);
            totalReplied += toNum(row.reply_count);
            totalBounced += toNum(row.bounced_count);
            totalLeads += toNum(row.leads_count);
          }

          return NextResponse.json({
            total_campaigns: rows.length,
            total_leads: totalLeads,
            total_sent: totalSent,
            total_opened: totalOpened,
            total_replied: totalReplied,
            total_bounced: totalBounced,
          });
        } catch (dbErr) {
          console.error('[instantly-analytics] overview DB read failed:', dbErr);
        }
      }
      const data = await instantly.getCampaignAnalyticsOverview({ campaign_id });
      return NextResponse.json(data);
    }

    case 'daily': {
      try {
        const data = await instantly.getCampaignAnalyticsDaily({ campaign_id, start_date, end_date });
        return NextResponse.json(data);
      } catch {
        return NextResponse.json([]);
      }
    }

    case 'steps': {
      if (!campaign_id) return NextResponse.json({ error: 'campaign_id is required' }, { status: 400 });
      try {
        const raw = await instantly.getCampaignAnalyticsSteps({ campaign_id });
        const items = Array.isArray(raw) ? raw : Array.isArray((raw as { data?: unknown }).data) ? (raw as { data: unknown[] }).data : [];
        return NextResponse.json(items);
      } catch {
        return NextResponse.json([]);
      }
    }

    default: {
      // type=campaigns
      // ── Path A: DB-first (default). Fast, but can be stale (1h sync cycle).
      if (useDb && supabaseInstantly) {
        try {
          const { items, freshness } = await readAnalyticsFromDb(
            supabaseInstantly as unknown as SupabaseClient,
            campaign_id,
          );
          return jsonWithSource(items, 'db', freshness);
        } catch (dbErr) {
          console.error('[instantly-analytics] campaigns DB read failed:', dbErr);
        }
      }

      // ── Path B: Instantly API (forced via ?source=api OR DB unavailable).
      // The bulk /campaigns/analytics endpoint is known to return sporadic 5xx
      // ("Unable to count leads") on workspaces with thousands of campaigns;
      // when that happens we transparently fall back to the cache so the
      // analyzer keeps working — the UI shows a freshness banner instead.
      try {
        const raw = await getCampaignAnalyticsWithRetry({ campaign_id });
        return jsonWithSource(normalizeApiList(raw), 'api');
      } catch (apiErr) {
        if (supabaseInstantly) {
          try {
            const { items, freshness } = await readAnalyticsFromDb(
              supabaseInstantly as unknown as SupabaseClient,
              campaign_id,
            );
            const apiMessage =
              apiErr instanceof Error ? apiErr.message : 'Instantly API error';
            console.warn('[instantly-analytics] API failed, served stale cache:', apiMessage);
            return jsonWithSource(items, 'db-fallback', freshness, apiMessage);
          } catch (dbErr) {
            console.error('[instantly-analytics] db-fallback read failed:', dbErr);
          }
        }
        throw apiErr;
      }
    }
  }
});

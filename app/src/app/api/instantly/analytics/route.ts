import { NextResponse } from 'next/server';
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
};

const ANALYTICS_COLS =
  'id,name,emails_sent_count,open_count,reply_count,bounced_count,new_leads_contacted_count,unsubscribed_count,leads_count';

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

export const GET = withAuth(async (req) => {
  const url = new URL(req.url);
  const type = url.searchParams.get('type') ?? 'campaigns';
  const campaign_id = url.searchParams.get('campaign_id') ?? undefined;
  const start_date = url.searchParams.get('start_date') ?? undefined;
  const end_date = url.searchParams.get('end_date') ?? undefined;

  switch (type) {
    case 'overview': {
      if (supabaseInstantly) {
        try {
          let query = supabaseInstantly
            .from('instantly_campaign_catalog')
            .select(ANALYTICS_COLS);

          if (campaign_id) query = query.eq('id', campaign_id);

          const { data, error } = await query;
          if (error) throw new Error(error.message);

          const rows = (data ?? []) as AnalyticsRow[];
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
      // type=campaigns — read from DB
      if (supabaseInstantly) {
        try {
          let query = supabaseInstantly
            .from('instantly_campaign_catalog')
            .select(ANALYTICS_COLS);

          if (campaign_id) query = query.eq('id', campaign_id);

          const { data, error } = await query;
          if (error) throw new Error(error.message);

          const items = ((data ?? []) as AnalyticsRow[]).map(rowToAnalytics);
          return NextResponse.json(items);
        } catch (dbErr) {
          console.error('[instantly-analytics] campaigns DB read failed:', dbErr);
        }
      }

      // Fallback: Instantly API
      const raw = await instantly.getCampaignAnalytics({ campaign_id });
      const items = Array.isArray(raw) ? raw : Array.isArray((raw as { data?: unknown }).data) ? (raw as { data: unknown[] }).data : [];
      return NextResponse.json(items);
    }
  }
});

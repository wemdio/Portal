import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import * as instantly from '@/lib/instantly/client';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (req) => {
  const url = new URL(req.url);
  const type = url.searchParams.get('type') ?? 'campaigns';
  const campaign_id = url.searchParams.get('campaign_id') ?? undefined;
  const start_date = url.searchParams.get('start_date') ?? undefined;
  const end_date = url.searchParams.get('end_date') ?? undefined;

  switch (type) {
    case 'overview': {
      const data = await instantly.getCampaignAnalyticsOverview({ campaign_id });
      return NextResponse.json(data);
    }
    case 'daily': {
      const data = await instantly.getCampaignAnalyticsDaily({ campaign_id, start_date, end_date });
      return NextResponse.json(data);
    }
    case 'steps': {
      if (!campaign_id) return NextResponse.json({ error: 'campaign_id is required' }, { status: 400 });
      const raw = await instantly.getCampaignAnalyticsSteps({ campaign_id });
      const items = Array.isArray(raw) ? raw : Array.isArray((raw as { data?: unknown }).data) ? (raw as { data: unknown[] }).data : [];
      return NextResponse.json(items);
    }
    default: {
      const raw = await instantly.getCampaignAnalytics({ campaign_id });
      const items = Array.isArray(raw) ? raw : Array.isArray((raw as { data?: unknown }).data) ? (raw as { data: unknown[] }).data : [];
      return NextResponse.json(items);
    }
  }
});

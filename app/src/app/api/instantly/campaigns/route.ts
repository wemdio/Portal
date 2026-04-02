import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import * as instantly from '@/lib/instantly/client';
import {
  upsertInstantlyCatalogFromCampaign,
  syncInstantlyCampaignCatalog,
  isCatalogStale,
} from '@/lib/tools/instantlyCampaignCatalog';
import { supabaseInstantly } from '@/lib/supabaseInstantly';

export const dynamic = 'force-dynamic';

const INSTANTLY_API_KEY =
  (process.env.INSTANTLY_API_KEY ?? process.env.INSTANTLY_PORTAL_API_KEY ?? '').trim();

type CatalogRow = {
  id: string;
  name: string;
  status: number | null;
  timestamp_created: string | null;
  timestamp_updated: string | null;
  synced_at: string;
};

export const GET = withAuth(async (req) => {
  const url = new URL(req.url);
  const limit = url.searchParams.get('limit');
  const starting_after = url.searchParams.get('starting_after') ?? undefined;
  const status = url.searchParams.get('status');

  // --- Primary: read from Instantly Supabase DB (synced hourly) ---
  if (supabaseInstantly) {
    try {
      const { data, error } = await supabaseInstantly
        .from('instantly_campaign_catalog')
        .select('id,name,status,timestamp_created,timestamp_updated,synced_at')
        .order('timestamp_created', { ascending: false, nullsFirst: false });

      if (error) throw new Error(error.message);

      const rows = (data ?? []) as CatalogRow[];

      if (rows.length > 0) {
        let maxSyncMs = 0;
        for (const row of rows) {
          if (row.synced_at) {
            const ms = Date.parse(row.synced_at);
            if (Number.isFinite(ms) && ms > maxSyncMs) maxSyncMs = ms;
          }
        }
        const lastSyncedAt = maxSyncMs > 0 ? new Date(maxSyncMs).toISOString() : null;

        if (INSTANTLY_API_KEY && isCatalogStale(lastSyncedAt)) {
          void syncInstantlyCampaignCatalog(INSTANTLY_API_KEY).catch((err) => {
            console.error('[instantly-catalog] background sync failed', err);
          });
        }

        let items = rows.map((row) => ({
          id: row.id,
          name: row.name,
          status: row.status,
          timestamp_created: row.timestamp_created,
          timestamp_updated: row.timestamp_updated,
        }));

        if (status) {
          const statusNum = parseInt(status, 10);
          items = items.filter((c) => c.status === statusNum);
        }

        if (limit === 'all') {
          return NextResponse.json({ items });
        }

        const numLimit = limit ? parseInt(limit, 10) : 100;

        let startIdx = 0;
        if (starting_after) {
          const idx = items.findIndex((c) => c.id === starting_after);
          if (idx >= 0) startIdx = idx + 1;
        }

        const page = items.slice(startIdx, startIdx + numLimit);
        const hasMore = startIdx + numLimit < items.length;

        return NextResponse.json({
          items: page,
          ...(hasMore ? { next_starting_after: page[page.length - 1]?.id } : {}),
        });
      }
    } catch (dbErr) {
      console.error('[instantly-campaigns] DB read failed, falling back to API:', dbErr);
    }
  }

  // --- Fallback: DB unavailable or empty — use Instantly API ---
  if (limit === 'all') {
    const campaigns = await instantly.listAllCampaigns();
    return NextResponse.json({ items: campaigns });
  }

  const numLimit = limit ? parseInt(limit, 10) : 100;

  if (numLimit > 100) {
    const all = await instantly.listAllCampaigns();
    all.sort((a, b) => {
      const ta = a.timestamp_created ?? '';
      const tb = b.timestamp_created ?? '';
      return tb > ta ? 1 : tb < ta ? -1 : 0;
    });
    return NextResponse.json({ items: all.slice(0, numLimit) });
  }

  const data = await instantly.listCampaigns({
    limit: numLimit,
    starting_after,
    status: status ? parseInt(status, 10) : undefined,
    tag_ids: url.searchParams.get('tag_ids') ?? undefined,
  });
  return NextResponse.json(data);
});

export const POST = withAuth(async (req) => {
  const body = await req.json();
  const campaign = await instantly.createCampaign(body);
  await upsertInstantlyCatalogFromCampaign(campaign);
  return NextResponse.json(campaign, { status: 201 });
});

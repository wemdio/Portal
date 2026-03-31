import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import * as instantly from '@/lib/instantly/client';
import {
  upsertInstantlyCatalogFromCampaign,
  readInstantlyCampaignCatalog,
  syncInstantlyCampaignCatalog,
  isCatalogStale,
} from '@/lib/tools/instantlyCampaignCatalog';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

const INSTANTLY_API_KEY =
  (process.env.INSTANTLY_API_KEY ?? process.env.INSTANTLY_PORTAL_API_KEY ?? '').trim();

export const GET = withAuth(async (req) => {
  const url = new URL(req.url);
  const limit = url.searchParams.get('limit');
  const starting_after = url.searchParams.get('starting_after') ?? undefined;
  const status = url.searchParams.get('status');
  const tag_ids = url.searchParams.get('tag_ids') ?? undefined;

  if (limit === 'all') {
    if (supabaseAdmin && INSTANTLY_API_KEY) {
      const { campaigns, lastSyncedAt } = await readInstantlyCampaignCatalog();
      const empty = campaigns.length === 0;
      const stale = isCatalogStale(lastSyncedAt);

      if (empty || stale) {
        void syncInstantlyCampaignCatalog(INSTANTLY_API_KEY).catch((err) => {
          console.error('[instantly-catalog] background sync failed', err);
        });
      }

      if (!empty) {
        return NextResponse.json({ items: campaigns });
      }
    }

    // Fallback: БД недоступна или пуста — тянем напрямую из Instantly
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
    tag_ids,
  });
  return NextResponse.json(data);
});

export const POST = withAuth(async (req) => {
  const body = await req.json();
  const campaign = await instantly.createCampaign(body);
  await upsertInstantlyCatalogFromCampaign(campaign);
  return NextResponse.json(campaign, { status: 201 });
});

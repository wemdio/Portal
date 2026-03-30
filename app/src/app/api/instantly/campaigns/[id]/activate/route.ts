import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import * as instantly from '@/lib/instantly/client';
import { upsertInstantlyCatalogFromCampaign } from '@/lib/tools/instantlyCampaignCatalog';

export const dynamic = 'force-dynamic';

export const POST = withAuth(async (_req, _user, params) => {
  const campaign = await instantly.activateCampaign(params!.id);
  await upsertInstantlyCatalogFromCampaign(campaign);
  return NextResponse.json(campaign);
});

import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import * as instantly from '@/lib/instantly/client';
import {
  deleteInstantlyCatalogCampaignById,
  upsertInstantlyCatalogFromCampaign,
} from '@/lib/tools/instantlyCampaignCatalog';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (_req, _user, params) => {
  const campaign = await instantly.getCampaign(params!.id);
  return NextResponse.json(campaign);
});

export const PATCH = withAuth(async (req, _user, params) => {
  const body = await req.json();
  const campaign = await instantly.updateCampaign(params!.id, body);
  await upsertInstantlyCatalogFromCampaign(campaign);
  return NextResponse.json(campaign);
});

export const DELETE = withAuth(async (_req, _user, params) => {
  const id = params!.id;
  const campaign = await instantly.deleteCampaign(id);
  await deleteInstantlyCatalogCampaignById(id);
  if (campaign !== undefined && campaign !== null) {
    return NextResponse.json(campaign);
  }
  return NextResponse.json({ ok: true, id });
});

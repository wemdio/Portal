import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import * as instantly from '@/lib/instantly/client';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (_req, _user, params) => {
  const campaign = await instantly.getCampaign(params!.id);
  return NextResponse.json(campaign);
});

export const PATCH = withAuth(async (req, _user, params) => {
  const body = await req.json();
  const campaign = await instantly.updateCampaign(params!.id, body);
  return NextResponse.json(campaign);
});

import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import * as instantly from '@/lib/instantly/client';

export const dynamic = 'force-dynamic';

export const POST = withAuth(async (_req, _user, params) => {
  const campaign = await instantly.pauseCampaign(params!.id);
  return NextResponse.json(campaign);
});

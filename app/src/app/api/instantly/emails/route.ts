import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import * as instantly from '@/lib/instantly/client';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (req) => {
  const url = new URL(req.url);
  const campaign_id = url.searchParams.get('campaign_id') ?? undefined;
  const lead_id = url.searchParams.get('lead_id') ?? undefined;
  const limit = url.searchParams.get('limit');
  const starting_after = url.searchParams.get('starting_after') ?? undefined;

  const data = await instantly.listEmails({
    campaign_id,
    lead_id,
    limit: limit ? parseInt(limit, 10) : 25,
    starting_after,
  });
  return NextResponse.json(data);
});

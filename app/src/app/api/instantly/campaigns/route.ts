import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import * as instantly from '@/lib/instantly/client';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (req) => {
  const url = new URL(req.url);
  const limit = url.searchParams.get('limit');
  const starting_after = url.searchParams.get('starting_after') ?? undefined;
  const status = url.searchParams.get('status');
  const tag_ids = url.searchParams.get('tag_ids') ?? undefined;

  if (limit === 'all') {
    const campaigns = await instantly.listAllCampaigns();
    return NextResponse.json({ items: campaigns });
  }

  const data = await instantly.listCampaigns({
    limit: limit ? parseInt(limit, 10) : 100,
    starting_after,
    status: status ? parseInt(status, 10) : undefined,
    tag_ids,
  });
  return NextResponse.json(data);
});

export const POST = withAuth(async (req) => {
  const body = await req.json();
  const campaign = await instantly.createCampaign(body);
  return NextResponse.json(campaign, { status: 201 });
});

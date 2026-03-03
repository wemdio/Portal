import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import * as instantly from '@/lib/instantly/client';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (req) => {
  const url = new URL(req.url);
  const limit = url.searchParams.get('limit');

  if (limit === 'all') {
    const lists = await instantly.listAllLeadLists();
    return NextResponse.json({ items: lists });
  }

  const starting_after = url.searchParams.get('starting_after') ?? undefined;
  const data = await instantly.listLeadLists({
    limit: limit ? parseInt(limit, 10) : 100,
    starting_after,
  });
  return NextResponse.json(data);
});

export const POST = withAuth(async (req) => {
  const body = await req.json();
  const list = await instantly.createLeadList(body);
  return NextResponse.json(list, { status: 201 });
});

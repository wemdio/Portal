import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import * as instantly from '@/lib/instantly/client';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (req) => {
  const url = new URL(req.url);
  const limit = url.searchParams.get('limit');
  const starting_after = url.searchParams.get('starting_after') ?? undefined;
  const search = url.searchParams.get('search') ?? undefined;

  if (limit === 'all') {
    const accounts = await instantly.listAllAccounts();
    return NextResponse.json({ items: accounts });
  }

  const data = await instantly.listAccounts({
    limit: limit ? parseInt(limit, 10) : 100,
    starting_after,
    search,
  });
  return NextResponse.json(data);
});

import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import * as instantly from '@/lib/instantly/client';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (req) => {
  const url = new URL(req.url);
  const resourceType = url.searchParams.get('resource_type') ?? undefined;

  if (url.searchParams.get('limit') === 'all') {
    const items = await instantly.listAllCustomTagMappings(resourceType);
    return NextResponse.json({ items });
  }

  const data = await instantly.listCustomTagMappings({
    limit: 100,
    starting_after: url.searchParams.get('starting_after') ?? undefined,
    tag_id: url.searchParams.get('tag_id') ?? undefined,
    resource_type: resourceType,
  });
  return NextResponse.json(data);
});

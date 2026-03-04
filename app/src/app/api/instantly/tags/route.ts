import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import * as instantly from '@/lib/instantly/client';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (req) => {
  const url = new URL(req.url);
  const limit = url.searchParams.get('limit');

  if (limit === 'all') {
    const tags = await instantly.listAllCustomTags();
    return NextResponse.json({ items: tags });
  }

  const starting_after = url.searchParams.get('starting_after') ?? undefined;
  const data = await instantly.listCustomTags({
    limit: limit ? parseInt(limit, 10) : 100,
    starting_after,
  });
  return NextResponse.json(data);
});

export const POST = withAuth(async (req) => {
  const body = await req.json();

  if (body.action === 'toggle') {
    const data = await instantly.toggleTagResource(body);
    return NextResponse.json(data);
  }

  const tag = await instantly.createCustomTag(body);
  return NextResponse.json(tag, { status: 201 });
});

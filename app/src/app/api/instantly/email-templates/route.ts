import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import * as instantly from '@/lib/instantly/client';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (req) => {
  const url = new URL(req.url);
  const starting_after = url.searchParams.get('starting_after') ?? undefined;
  const limit = url.searchParams.get('limit');
  const data = await instantly.listEmailTemplates({
    limit: limit ? parseInt(limit, 10) : 100,
    starting_after,
  });
  return NextResponse.json(data);
});

export const POST = withAuth(async (req) => {
  const body = await req.json();
  const template = await instantly.createEmailTemplate(body);
  return NextResponse.json(template, { status: 201 });
});

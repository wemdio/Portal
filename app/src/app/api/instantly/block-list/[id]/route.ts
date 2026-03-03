import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import * as instantly from '@/lib/instantly/client';

export const dynamic = 'force-dynamic';

export const PATCH = withAuth(async (req, _user, params) => {
  const body = await req.json();
  const entry = await instantly.updateBlockListEntry(params!.id, body);
  return NextResponse.json(entry);
});

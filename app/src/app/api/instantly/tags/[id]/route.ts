import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import * as instantly from '@/lib/instantly/client';

export const dynamic = 'force-dynamic';

export const PATCH = withAuth(async (req, _user, params) => {
  const body = await req.json();
  const tag = await instantly.updateCustomTag(params!.id, body);
  return NextResponse.json(tag);
});

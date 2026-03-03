import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import * as instantly from '@/lib/instantly/client';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (_req, _user, params) => {
  const list = await instantly.getLeadList(params!.id);
  return NextResponse.json(list);
});

export const PATCH = withAuth(async (req, _user, params) => {
  const body = await req.json();
  const list = await instantly.updateLeadList(params!.id, body);
  return NextResponse.json(list);
});

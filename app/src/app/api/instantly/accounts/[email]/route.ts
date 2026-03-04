import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import * as instantly from '@/lib/instantly/client';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (_req, _user, params) => {
  const account = await instantly.getAccount(params!.email);
  return NextResponse.json(account);
});

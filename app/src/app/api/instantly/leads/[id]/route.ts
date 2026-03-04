import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import * as instantly from '@/lib/instantly/client';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (_req, _user, params) => {
  const lead = await instantly.getLead(params!.id);
  return NextResponse.json(lead);
});

export const PATCH = withAuth(async (req, _user, params) => {
  const body = await req.json();
  const lead = await instantly.updateLead(params!.id, body);
  return NextResponse.json(lead);
});

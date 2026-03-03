import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import * as instantly from '@/lib/instantly/client';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (_req, _user, params) => {
  const webhook = await instantly.getWebhook(params!.id);
  return NextResponse.json(webhook);
});

export const PATCH = withAuth(async (req, _user, params) => {
  const body = await req.json();
  const webhook = await instantly.updateWebhook(params!.id, body);
  return NextResponse.json(webhook);
});

export const POST = withAuth(async (_req, _user, params) => {
  const data = await instantly.testWebhook(params!.id);
  return NextResponse.json(data);
});

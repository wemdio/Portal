import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import * as instantly from '@/lib/instantly/client';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (_req, _user, params) => {
  const sub = await instantly.getSubsequence(params!.id);
  return NextResponse.json(sub);
});

export const PATCH = withAuth(async (req, _user, params) => {
  const body = await req.json();
  const sub = await instantly.updateSubsequence(params!.id, body);
  return NextResponse.json(sub);
});

export const POST = withAuth(async (req, _user, params) => {
  const { action } = (await req.json()) as { action: string };

  switch (action) {
    case 'duplicate': {
      const sub = await instantly.duplicateSubsequence(params!.id);
      return NextResponse.json(sub);
    }
    case 'pause': {
      const sub = await instantly.pauseSubsequence(params!.id);
      return NextResponse.json(sub);
    }
    case 'resume': {
      const sub = await instantly.resumeSubsequence(params!.id);
      return NextResponse.json(sub);
    }
    default:
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  }
});

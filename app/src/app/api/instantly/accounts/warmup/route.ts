import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import * as instantly from '@/lib/instantly/client';

export const dynamic = 'force-dynamic';

export const POST = withAuth(async (req) => {
  const { emails, action } = (await req.json()) as { emails: string[]; action: 'enable' | 'disable' };

  if (action === 'enable') {
    await instantly.enableWarmup(emails);
  } else {
    await instantly.disableWarmup(emails);
  }

  return NextResponse.json({ ok: true });
});

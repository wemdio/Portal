import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth } from '@/lib/clientApiHelper';
import { getClientTariffUsage } from '@/lib/tariffs';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;

  const { userId } = result.auth;
  const summary = await getClientTariffUsage(userId);

  return NextResponse.json(summary);
}

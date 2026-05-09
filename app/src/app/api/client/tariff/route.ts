import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { getClientTariffRow, resolveEffectiveLimits, getClientStatus } from '@/lib/tariffs';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;

  const { userId } = result.auth;
  const row = await getClientTariffRow(userId);
  const limits = resolveEffectiveLimits(row);
  const status = getClientStatus(row);

  return NextResponse.json({
    tariff_type: row?.tariff_type ?? 'standard',
    status,
    paid_at: row?.paid_at ?? null,
    paid_until: row?.paid_until ?? null,
    setup_until: row?.setup_until ?? null,
    limits,
  });
}

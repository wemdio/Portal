import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { filterAllowedIds } from '@/lib/clientAccess';
import { listAllLeadLists } from '@/lib/instantly/client';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  const { accessRows } = result.auth;

  const allowedListIds = filterAllowedIds([], accessRows, 'lead_list');
  if (allowedListIds.length === 0) {
    return NextResponse.json({ items: [] });
  }

  try {
    const allLists = await listAllLeadLists();
    const allowedSet = new Set(allowedListIds);
    const items = allLists.filter((l) => allowedSet.has(l.id));
    return NextResponse.json({ items });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка загрузки';
    return jsonError(message, 500);
  }
}

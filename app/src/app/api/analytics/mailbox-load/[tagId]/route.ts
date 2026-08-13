import { NextRequest, NextResponse } from 'next/server';
import { isDatasetConfigured } from '@/lib/instantlyDataset';
import { getTagMailboxes } from '@/lib/instantly/mailboxLoad';
import { requireMailboxLoadAccess } from '../access';

export const dynamic = 'force-dynamic';

/**
 * GET /api/analytics/mailbox-load/[tagId]?day=YYYY-MM-DD
 * Drill-down: ящики одного тега за день. Только руководство (см. ../access.ts).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ tagId: string }> },
) {
  const denied = await requireMailboxLoadAccess(req);
  if (denied) return denied;

  if (!isDatasetConfigured()) {
    return NextResponse.json({ error: 'dataset_not_configured', mailboxes: [] }, { status: 503 });
  }
  const { tagId } = await params;
  const day = req.nextUrl.searchParams.get('day') ?? undefined;
  try {
    const data = await getTagMailboxes(tagId, day);
    return NextResponse.json(data);
  } catch (e) {
    const detail = (e as Error).message;
    console.error('[mailbox-load drill] failed:', detail);
    // 500, не 200 — фронт различает сбой и честно пустой тег. Причина уходит и
    // в ответ: роут за тем же гейтом на руководство, а без неё раскрытие тега
    // ломалось так же безмолвно, как и весь дашборд.
    return NextResponse.json({ error: 'build_failed', detail, mailboxes: [] }, { status: 500 });
  }
}

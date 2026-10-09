import { NextRequest, NextResponse } from 'next/server';
import { isDatasetConfigured } from '@/lib/instantlyDataset';
import { buildMailboxOutcomes } from '@/lib/instantly/mailboxOutcomes';
import { resolveAsOf } from '@/lib/instantly/mailboxLoad';
import { requireMailboxLoadAccess } from '../access';

export const dynamic = 'force-dynamic';

/**
 * GET /api/analytics/mailbox-load/outcomes?day=YYYY-MM-DD
 * Исходы рассылки за день и за 30 дней до него: отправлено, негатив, ответы,
 * лиды. Отдельным роутом от самой нагрузки намеренно: запросы тяжелее и
 * независимы, и страница не должна ждать их, чтобы показать таблицу ящиков.
 *
 * Доступ — тот же гейт на руководство, что и у остальных роутов mailbox-load.
 * Статический сегмент `outcomes` в App Router выигрывает у соседнего [tagId].
 */
export async function GET(req: NextRequest) {
  const denied = await requireMailboxLoadAccess(req);
  if (denied) return denied;

  if (!isDatasetConfigured()) {
    return NextResponse.json({ error: 'dataset_not_configured', data: null }, { status: 503 });
  }

  try {
    // День берём через ту же resolveAsOf, что и основная страница: она же
    // отбрасывает ещё не долитый день, иначе блок показывал бы нули.
    const { asOfDay } = await resolveAsOf(req.nextUrl.searchParams.get('day') ?? undefined);
    if (!asOfDay) return NextResponse.json({ data: null, error: 'no_data' });
    const data = await buildMailboxOutcomes(asOfDay);
    return NextResponse.json({ data });
  } catch (e) {
    const detail = (e as Error).message;
    console.error('[mailbox-outcomes] build failed:', detail);
    return NextResponse.json({ error: 'build_failed', detail, data: null }, { status: 500 });
  }
}

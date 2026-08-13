import { NextRequest, NextResponse } from 'next/server';
import { isDatasetConfigured } from '@/lib/instantlyDataset';
import { buildMailboxLoad } from '@/lib/instantly/mailboxLoad';
import { requireMailboxLoadAccess } from './access';

export const dynamic = 'force-dynamic';

/**
 * GET /api/analytics/mailbox-load?day=YYYY-MM-DD
 * Нагрузка на ящики по тегам и специалистам за день (по умолчанию — последний
 * полный день в датасете). Только руководство (lead/director/admin) — как и
 * страница: middleware-гейт /api/* пускает ЛЮБОЙ internal-staff, поэтому
 * роль сужаем здесь.
 */
export async function GET(req: NextRequest) {
  const denied = await requireMailboxLoadAccess(req);
  if (denied) return denied;

  if (!isDatasetConfigured()) {
    return NextResponse.json({ error: 'dataset_not_configured', data: null }, { status: 503 });
  }
  const day = req.nextUrl.searchParams.get('day') ?? undefined;
  try {
    const data = await buildMailboxLoad(day);
    return NextResponse.json({ data });
  } catch (e) {
    const detail = (e as Error).message;
    console.error('[mailbox-load] build failed:', detail);
    // 500, не 200 — иначе сбой датасета невидим для мониторинга по статус-кодам.
    //
    // `detail` отдаём наружу намеренно: до этого на экране был голый код
    // `build_failed`, а настоящая причина («relation ... does not exist»,
    // таймаут, отвалившийся пул) оставалась только в консоли сервера — и любой
    // сбой выглядел одинаково, вплоть до похода в docker logs. Роут закрыт
    // гейтом на руководство (см. access.ts), так что читать текст ошибки
    // некому, кроме тех, кто и так пойдёт её чинить.
    return NextResponse.json({ error: 'build_failed', detail, data: null }, { status: 500 });
  }
}

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireExpensesAccess } from '@/lib/expenses/access';
import type { ProjectOption } from '@/lib/expenses/types';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

/** Статусы, при которых проект ещё идёт: такие стоят в выборе первыми. */
const LIVE_STATUSES = new Set(['В работе', 'Тестирование', 'На паузе', 'Подготовка']);

/**
 * Проекты портала для привязки ручной записи. Отдаём все разом: их пара сотен,
 * и поиск по ним в выпадающем списке быстрее делать на месте, чем ходить на
 * сервер на каждую букву.
 */
export async function GET(req: NextRequest) {
  const guard = await requireExpensesAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const { data, error } = await supabaseAdmin
    .from('projects')
    .select('id, name, client, status')
    .order('name', { ascending: true })
    .limit(2000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const items: ProjectOption[] = (data ?? [])
    .map((p) => ({
      id: String(p.id),
      name: String(p.name),
      client: (p.client as string | null) ?? null,
      status: String(p.status),
    }))
    // Идущие проекты выше завершённых: привязывают почти всегда к текущим.
    .sort((a, b) => Number(LIVE_STATUSES.has(b.status)) - Number(LIVE_STATUSES.has(a.status))
      || a.name.localeCompare(b.name, 'ru'));

  return NextResponse.json({ items });
}

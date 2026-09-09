import 'server-only';
import { NextRequest, NextResponse } from 'next/server';

import { requireRenewalsAccess } from '@/lib/renewals/access';
import { fetchRenewalsFunnel } from '@/lib/renewals/funnel';
import { parseRenewalsParams } from '@/lib/renewals/params';

// Роут авторизуется по заголовку — предрендер здесь дал бы либо пустой ответ,
// либо чужой. Явно снимаем этот вопрос, как и соседний summary.
export const dynamic = 'force-dynamic';

/**
 * Воронка вторичных продаж за период.
 *
 * Окно то же, что у плиток и таблицы: страница фильтруется целиком, иначе
 * блоки под одним фильтром показывают разное и расхождение приходится
 * объяснять в переписке. Отбор когортный — по дате заведения сделки (см.
 * lib/renewals/funnel.ts): «что пришло в работу за период и докуда дошло».
 * Значит проекты, заведённые раньше окна, в воронке периода не видны, даже
 * если сейчас движутся, — это свойство когорты, а не потеря данных.
 */
export async function GET(req: NextRequest) {
  const gate = await requireRenewalsAccess(req);
  if ('error' in gate) return gate.error;

  const parsed = parseRenewalsParams(new URL(req.url));
  // Сужение по `parsed.value === null` — как в соседнем summary/route.ts.
  if (parsed.value === null) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { from, to } = parsed.value;

  try {
    const funnel = await fetchRenewalsFunnel(gate.supabaseAdmin, { from, to });
    return NextResponse.json(funnel);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'renewals_funnel_failed' },
      { status: 500 },
    );
  }
}

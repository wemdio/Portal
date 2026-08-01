import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { requireRenewalsAccess } from '@/lib/renewals/access';
import { parseRenewalsParams } from '@/lib/renewals/params';
import { computeRenewalsMetrics, fetchRenewalPeriods, fetchRenewalProjects } from '@/lib/renewals/metrics';
import { buildRenewalTableRows } from '@/lib/renewals/tableRows';
import { bucketKey } from '@/lib/firstSales/buckets';

// Роут авторизуется по заголовку и зависит от query — предрендер здесь дал бы
// либо пустой ответ, либо чужой. Явно снимаем этот вопрос, как и соседние
// роуты аналитики (см. api/analytics/first-sales/summary/route.ts).
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  // `'error' in gate` — принятое в проекте сужение размеченного объединения,
  // работает только благодаря явной аннотации типа в renewals/access.ts.
  const gate = await requireRenewalsAccess(req);
  if ('error' in gate) return gate.error;
  const db = gate.supabaseAdmin;

  const parsed = parseRenewalsParams(new URL(req.url));
  // Сужаем по `parsed.value === null`, а не по `parsed.error` — тот же приём,
  // что в firstSales/summary/route.ts: truthy-сужение по `error` здесь тоже
  // не работает на используемой версии tsc.
  if (parsed.value === null) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { from, to, groupBy, kpiFilter } = parsed.value;

  try {
    const rows = await fetchRenewalProjects(db);
    const projectIds = rows.map((r) => r.id);
    const periods = await fetchRenewalPeriods(db, projectIds);

    const today = new Date();
    const result = computeRenewalsMetrics(rows, periods, from, to, groupBy, kpiFilter, today);

    // Таблица срезана тем же периодом, что и плитки: страница фильтруется
    // целиком, а не по частям. Две выборки под одним фильтром разошлись бы, и
    // объяснять расхождение пришлось бы в переписке.
    //
    // Границы приводим к ключу дня в МСК — тем же bucketKey, которым считаются
    // корзины. Сравнивать даты оплаты (они уже строки YYYY-MM-DD) с ISO-меткой
    // времени напрямую нельзя: `'2026-07-15' > '2026-07-15T00:00:00.000Z'`
    // ложно, и последний день периода потерялся бы.
    const tableRows = buildRenewalTableRows(rows, kpiFilter, bucketKey(today, 'day'), {
      fromKey: bucketKey(from, 'day'),
      toKey: bucketKey(to, 'day'),
    });

    return NextResponse.json({ ...result, tableRows });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'renewals_summary_failed' },
      { status: 500 },
    );
  }
}

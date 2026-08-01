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

    // Таблица строится из тех же `rows`, но НЕ срезана диапазоном дат — см.
    // комментарий в tableRows.ts. Диапазон дат управляет плитками и графиком
    // (метриками периода), таблица остаётся полным списком продлений,
    // прошедшим только фильтр KPI, — так «без даты» и «запланировано» видно
    // и построчно, а не только цифрой в плитке.
    const tableRows = buildRenewalTableRows(rows, kpiFilter, bucketKey(today, 'day'));

    return NextResponse.json({ ...result, tableRows });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'renewals_summary_failed' },
      { status: 500 },
    );
  }
}

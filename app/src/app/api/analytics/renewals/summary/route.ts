import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { requireRenewalsAccess } from '@/lib/renewals/access';
import { parseRenewalsParams } from '@/lib/renewals/params';
import { computeRenewalsMetrics, fetchRenewalMarks, fetchRevenueTransactions } from '@/lib/renewals/metrics';
import { buildRenewalTableRows } from '@/lib/renewals/tableRows';
import { bucketKey } from '@/lib/firstSales/buckets';

// Роут авторизуется по заголовку и зависит от query — предрендер здесь дал бы
// либо пустой ответ, либо чужой. Явно снимаем этот вопрос, как и соседние
// роуты аналитики (см. api/analytics/first-sales/summary/route.ts).
export const dynamic = 'force-dynamic';

// Тот же приём, что first-sales/leads/route.ts: базовый URL AMO-аккаунта из
// окружения, без хвостового слэша. `null`, если переменная не задана —
// buildRenewalTableRows в этом случае просто не даёт ссылку на сделку.
const AMO_BASE_URL = (process.env.AMO_BASE_URL ?? '').replace(/\/$/, '') || null;

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
  const { from, to, groupBy } = parsed.value;

  try {
    // Обе выборки — вся история, не только окно [from, to]: ранжирование
    // «какой платёж по счёту у ИНН» требует видеть платежи ДО периода (см.
    // doc-комментарий computeRenewalsMetrics в metrics.ts). Окно применяется
    // только внутри computeRenewalsMetrics/buildRenewalTableRows.
    const [marks, transactions] = await Promise.all([
      fetchRenewalMarks(db),
      fetchRevenueTransactions(db),
    ]);

    const result = computeRenewalsMetrics(marks, transactions, from, to, groupBy);

    // Таблица срезана тем же периодом, что и плитки: страница фильтруется
    // целиком, а не по частям. Границы приводим к ключу дня в МСК — тем же
    // bucketKey, которым фильтрует сама computeRenewalsMetrics.
    const tableRows = buildRenewalTableRows(marks, transactions, AMO_BASE_URL, {
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

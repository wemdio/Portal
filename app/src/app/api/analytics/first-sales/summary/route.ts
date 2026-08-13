import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { requireFirstSalesAccess } from '@/lib/firstSales/access';
import { parseFirstSalesParams, previousWindow } from '@/lib/firstSales/params';
import {
  computeFirstSalesSeries,
  fetchFirstSalesLeads,
  fetchSourceMap,
} from '@/lib/firstSales/metrics';
import { fetchMeetingLinks } from '@/lib/firstSales/meetings';
import { fetchFirstSalesPayments } from '@/lib/firstSales/money';

// Роут авторизуется по заголовку и зависит от query — предрендер здесь дал бы
// либо пустой ответ, либо чужой. Явно снимаем этот вопрос, как и соседние
// роуты аналитики.
export const dynamic = 'force-dynamic';

const PIPELINE_ID = Number(process.env.FIRST_SALES_PIPELINE_ID ?? '7670334');

export async function GET(req: NextRequest) {
  // `'error' in gate` — принятое в проекте сужение размеченного объединения
  // (см. src/app/api/database-review/requests/route.ts). Через `gate.error`
  // TypeScript union не сузит.
  const gate = await requireFirstSalesAccess(req);
  if ('error' in gate) return gate.error;
  const db = gate.supabaseAdmin;

  const parsed = parseFirstSalesParams(new URL(req.url));
  // `if (parsed.error)` не сужает `parsed.value` на tsc 5.9.3 для объединения
  // `{ value: T; error: null } | { value: null; error: string }` — та же
  // ловушка с truthy-сужением, что задокументирована в firstSales/access.ts.
  // Сужаем по `parsed.value === null`, второй половине того же дискриминанта.
  if (parsed.value === null) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { from, to, groupBy, channels } = parsed.value;

  // Предыдущее окно считается отдельной выборкой: расширять текущее нельзя —
  // ряд по времени раздуется вдвое и график покажет лишнее.
  const prev = previousWindow(from, to);

  // Привязки встреч тянутся раньше сделок: список задействованных amo_deal_id
  // идёт в fetchFirstSalesLeads как extraDealIds — иначе сделка, пришедшая
  // раньше окна (встреча в июле у мартовской сделки), не попадёт в `leads`,
  // и computeFirstSalesSeries не сможет резолвнуть её канал для встречи.
  // Внутри окна эта пара запросов последовательна по существу; два окна между
  // собой — нет, и раньше они всё равно шли друг за другом (см. Promise.all
  // ниже). Цена была заметной: каждое чтение `amo_lead_stage_dates_v`
  // материализует историю событий целиком, фильтр туда не проваливается.
  // Платежи тянутся вместе со встречами и по той же причине попадают в
  // extraDealIds: сделка могла прийти в марте, а деньги по ней — в августе.
  // Без неё в выборке `computeFirstSalesSeries` не сможет резолвнуть канал и
  // менеджера сделки, и деньги ушли бы в «не распределено».
  const loadWindow = async (windowFrom: Date, windowTo: Date) => {
    const [meetingLinks, payments] = await Promise.all([
      fetchMeetingLinks(db, PIPELINE_ID, windowFrom, windowTo),
      fetchFirstSalesPayments(db, PIPELINE_ID, windowFrom, windowTo),
    ]);
    const extraDealIds = [
      ...new Set([
        ...meetingLinks.map((m) => m.amo_deal_id),
        ...payments.map((p) => p.amo_deal_id).filter((id): id is number => id != null),
      ]),
    ];
    const leads = await fetchFirstSalesLeads(db, PIPELINE_ID, windowFrom, windowTo, extraDealIds);
    return { meetingLinks, payments, leads };
  };

  try {
    const [current, previous, sourceMap, lastRunRes] = await Promise.all([
      loadWindow(from, to),
      loadWindow(prev.from, prev.to),
      fetchSourceMap(db),
      // Дата последнего успешного синка — на дашборд. Тихо устаревшие цифры
      // хуже отсутствующих: пользователь должен видеть, что данные вчерашние.
      db
        .from('external_sync_runs')
        .select('finished_at')
        .eq('source', 'amo_events')
        .eq('status', 'success')
        .order('finished_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    const result = computeFirstSalesSeries(
      current.leads, current.meetingLinks, sourceMap, from, to, groupBy, channels,
      current.payments,
    );
    const prevResult = computeFirstSalesSeries(
      previous.leads, previous.meetingLinks, sourceMap, prev.from, prev.to, groupBy, channels,
      previous.payments,
    );

    const lastRun = lastRunRes.data;

    return NextResponse.json({
      ...result,
      previousTotals: prevResult.totals,
      syncedAt: lastRun?.finished_at ?? null,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'first_sales_summary_failed' },
      { status: 500 },
    );
  }
}

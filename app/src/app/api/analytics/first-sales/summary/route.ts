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

  try {
    // Привязки встреч тянем раньше сделок: список задействованных amo_deal_id
    // идёт в fetchFirstSalesLeads как extraDealIds — иначе сделка, пришедшая
    // раньше окна (встреча в июле у мартовской сделки), не попадёт в `leads`,
    // и computeFirstSalesSeries не сможет резолвнуть её канал для встречи.
    const meetingLinks = await fetchMeetingLinks(db, PIPELINE_ID, from, to);
    const meetingDealIds = [...new Set(meetingLinks.map((m) => m.amo_deal_id))];

    const [leads, sourceMap] = await Promise.all([
      fetchFirstSalesLeads(db, PIPELINE_ID, from, to, meetingDealIds),
      fetchSourceMap(db),
    ]);

    const result = computeFirstSalesSeries(leads, meetingLinks, sourceMap, from, to, groupBy, channels);

    // Предыдущее окно тянем отдельным запросом: расширять текущее нельзя —
    // ряд по времени раздуется вдвое и график покажет лишнее.
    const prev = previousWindow(from, to);
    const prevMeetingLinks = await fetchMeetingLinks(db, PIPELINE_ID, prev.from, prev.to);
    const prevMeetingDealIds = [...new Set(prevMeetingLinks.map((m) => m.amo_deal_id))];
    const prevLeads = await fetchFirstSalesLeads(db, PIPELINE_ID, prev.from, prev.to, prevMeetingDealIds);
    const prevResult = computeFirstSalesSeries(
      prevLeads, prevMeetingLinks, sourceMap, prev.from, prev.to, groupBy, channels,
    );

    // Дата последнего успешного синка — на дашборд. Тихо устаревшие цифры хуже
    // отсутствующих: пользователь должен видеть, что данные вчерашние.
    const { data: lastRun } = await db
      .from('external_sync_runs')
      .select('finished_at')
      .eq('source', 'amo_events')
      .eq('status', 'success')
      .order('finished_at', { ascending: false })
      .limit(1)
      .maybeSingle();

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

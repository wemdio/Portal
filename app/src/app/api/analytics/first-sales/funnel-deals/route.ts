import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { requireFirstSalesAccess } from '@/lib/firstSales/access';
import { parseFirstSalesParams } from '@/lib/firstSales/params';
import { deepestStage, groupByDeepestStage, stageDate } from '@/lib/firstSales/funnelDeals';
import {
  fetchFirstSalesLeads,
  isContractInWindow,
  isLeadInWindow,
  isQualifiedInWindow,
  isSaleInWindow,
  lastMeetingByDeal,
  meetingsByDeal,
  stageAvailability,
} from '@/lib/firstSales/metrics';
import { fetchMeetingLinks } from '@/lib/firstSales/meetings';
import { fetchFirstSalesPayments, moneyByDeal } from '@/lib/firstSales/money';
import { resolveSource } from '@/lib/firstSales/sources';

/**
 * Список сделок рядом с воронкой, сгруппированный по ступеням.
 *
 * Считает теми же функциями, что и сама воронка (`isLeadInWindow`,
 * `isQualifiedInWindow`, `meetingsByDeal`, `isContractInWindow`), — иначе
 * длина списка разойдётся с цифрой на ступени, и объяснять расхождение
 * придётся в переписке. Раскладка «сделка идёт в самую глубокую ступень» —
 * в lib/firstSales/funnelDeals.ts, там же объяснено почему.
 *
 * Ограничения на количество сделок нет намеренно: обрезанный список выглядит
 * полным и врёт молча. Браузеру помогает не количество строк в ответе, а то,
 * что список дорисовывает их по мере прокрутки (см. FunnelDealsList.tsx).
 */
export const dynamic = 'force-dynamic';

const PIPELINE_ID = Number(process.env.FIRST_SALES_PIPELINE_ID ?? '7670334');
const AMO_BASE = (process.env.AMO_BASE_URL ?? '').replace(/\/$/, '');

export async function GET(req: NextRequest) {
  const gate = await requireFirstSalesAccess(req);
  if ('error' in gate) return gate.error;

  const url = new URL(req.url);
  const parsed = parseFirstSalesParams(url);
  // `parsed.value === null`, а не `parsed.error` — то же сужение, что в
  // соседних роутах аналитики (truthy-сужение объединения тут не работает).
  if (parsed.value === null) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { from, to, sources } = parsed.value;

  try {
    // Та же ширина выборки, что в summary/route.ts: сделка может лежать вне
    // окна по created_at/этапам, а встреча или оплата по ней — случиться
    // внутри окна.
    const [meetingLinks, payments] = await Promise.all([
      fetchMeetingLinks(gate.supabaseAdmin, PIPELINE_ID, from, to),
      fetchFirstSalesPayments(gate.supabaseAdmin, PIPELINE_ID, from, to),
    ]);
    const extraDealIds = [
      ...new Set([
        ...meetingLinks.map((m) => m.amo_deal_id),
        ...payments.map((p) => p.amo_deal_id).filter((id): id is number => id != null),
      ]),
    ];

    const leads = await fetchFirstSalesLeads(
      gate.supabaseAdmin, PIPELINE_ID, from, to, extraDealIds,
    );

    const meetings = meetingsByDeal(meetingLinks, from, to);
    const meetingAt = lastMeetingByDeal(meetingLinks, from, to);
    const money = moneyByDeal(payments, from, to);

    // Достоверность ступеней берём той же функцией, что и сводка: правило
    // «окно раньше даты — ступени нет» обязано быть одно на весь экран.
    const available = stageAvailability(to);

    const allowedSources = sources === null ? null : new Set(sources);

    const rows = leads
      .filter((lead) => allowedSources === null || allowedSources.has(resolveSource(lead.raw).key))
      .map((lead) => ({
        amo_id: lead.amo_id,
        name: lead.name,
        company_name: lead.company_name,
        responsible_name: lead.responsible_name,
        created_at: lead.created_at,
        // Даты событий, которыми сделка попала в период. Строка списка
        // показывает именно их: `created_at` у старой сделки со встречей в
        // окне читается как «фильтр не сработал».
        won_at: lead.won_at,
        meeting_at: meetingAt.get(lead.amo_id) ?? null,
        history_complete: lead.history_complete,
        in_period: {
          lead: isLeadInWindow(lead, from, to),
          qualified: isQualifiedInWindow(lead, from, to),
          meetings: meetings.get(lead.amo_id) ?? 0,
          sale: isSaleInWindow(lead, from, to),
          // Этап «Согласование договора» — отметка в строке, а не ступень
          // воронки: пять августовских продаж его вообще не проходили.
          contract: isContractInWindow(lead, from, to),
          money: money.get(lead.amo_id) ?? 0,
        },
        amo_url: AMO_BASE ? `${AMO_BASE}/leads/detail/${lead.amo_id}` : null,
      }))
      // Свежие сверху — но по дате события периода, а не создания сделки:
      // строка показывает именно её, и порядок обязан совпадать с видимым.
      .sort((a, b) => {
        const key = (row: typeof a) => {
          const stage = deepestStage(row.in_period, available);
          return (stage === null ? row.created_at : stageDate(stage, row)) ?? '';
        };
        return key(b).localeCompare(key(a));
      });

    const groups = groupByDeepestStage(rows, (row) => row.in_period, available);

    return NextResponse.json({ groups });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'first_sales_funnel_deals_failed' },
      { status: 500 },
    );
  }
}

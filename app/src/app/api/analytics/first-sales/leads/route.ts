import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { requireFirstSalesAccess } from '@/lib/firstSales/access';
import { parseFirstSalesParams } from '@/lib/firstSales/params';
import { matchesDrill, parseDrillSlice } from '@/lib/firstSales/drill';
import {
  fetchFirstSalesLeads,
  isContractInWindow,
  isLeadInWindow,
  isQualifiedInWindow,
  meetingsByDeal,
} from '@/lib/firstSales/metrics';
import { fetchMeetingLinks } from '@/lib/firstSales/meetings';
import { fetchFirstSalesPayments, moneyByDeal } from '@/lib/firstSales/money';

// Роут авторизуется по заголовку и зависит от query — предрендер здесь дал бы
// либо пустой ответ, либо чужой. Тот же паттерн, что у summary/route.ts.
export const dynamic = 'force-dynamic';

const PIPELINE_ID = Number(process.env.FIRST_SALES_PIPELINE_ID ?? '7670334');
const AMO_BASE = (process.env.AMO_BASE_URL ?? '').replace(/\/$/, '');
const MAX_ROWS = 200;

export async function GET(req: NextRequest) {
  const gate = await requireFirstSalesAccess(req);
  if ('error' in gate) return gate.error;

  const url = new URL(req.url);
  const parsed = parseFirstSalesParams(url);
  // `parsed.value === null`, а не `parsed.error` — то же сужение, что в
  // summary/route.ts (truthy-сужение объединения тут не работает на tsc 5.9.3).
  if (parsed.value === null) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { from, to } = parsed.value;

  // Срез, в который проваливается пользователь: либо источник, либо менеджер.
  //
  // `source` — это КЛЮЧ источника, а не название: `enum_id` строкой либо
  // `none` для сделок без заполненного «Источник». `manager` — наоборот,
  // отображаемое имя ответственного, ровно как его показывает разбивка,
  // включая литерал `NO_MANAGER` для сделок без ответственного.
  //
  // Разбор и правила отбора — в lib/firstSales/drill.ts: там же объяснено,
  // почему фильтр источников из шапки применяется к срезу по менеджеру и не
  // применяется к срезу по источнику.
  const slice = parseDrillSlice(url);
  if (slice.value === null) return NextResponse.json({ error: slice.error }, { status: 400 });
  const matchesSlice = matchesDrill(slice.value, parsed.value.sources);

  try {
    // Та же ширина выборки, что в summary/route.ts: сделка может лежать вне
    // окна по created_at/этапам (пришла раньше), а встреча или оплата по ней —
    // случиться внутри окна. Без этого расширения drill-down показал бы меньше
    // сделок, чем сводка насчитала встреч и денег для того же среза.
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

    // Встречи и деньги по сделкам — теми же правилами, что и цифры разбивки
    // (окно, порог достоверности встреч, дедуп «одна сделка — один день»,
    // отсев продлений и спорных платежей). Считаются один раз на запрос.
    const meetings = meetingsByDeal(meetingLinks, from, to);
    const money = moneyByDeal(payments, from, to);

    const rows = leads
      .filter(matchesSlice)
      .map((lead) => ({
        lead,
        hits: {
          lead: isLeadInWindow(lead, from, to),
          qualified: isQualifiedInWindow(lead, from, to),
          meetings: meetings.get(lead.amo_id) ?? 0,
          contract: isContractInWindow(lead, from, to),
          money: money.get(lead.amo_id) ?? 0,
        },
      }))
      // Выборка сознательно шире периода — сделка попадает в неё, если по ней
      // была активность в окне ИЛИ она понадобилась для встречи/оплаты. Здесь
      // остаются только те, что реально дали периоду хоть одну цифру: иначе
      // под строкой «269 лидов за август» показывались сделки 2024 года, и
      // это читалось как «фильтр периода не работает».
      .filter(({ hits }) =>
        hits.lead || hits.qualified || hits.meetings > 0 || hits.contract || hits.money > 0,
      )
      .sort((a, b) => (b.lead.created_at ?? '').localeCompare(a.lead.created_at ?? ''))
      .slice(0, MAX_ROWS)
      .map(({ lead, hits }) => ({
        amo_id: lead.amo_id,
        name: lead.name,
        // Ответственный отдаётся как есть, включая null: пустая клетка в
        // списке — это «в AMO за сделкой никто не закреплён», и подменять её
        // прочерком-«неизвестно» нельзя, состояние разное.
        responsible_name: lead.responsible_name,
        created_at: lead.created_at,
        first_meeting_at: lead.first_meeting_at,
        first_contract_at: lead.first_contract_at,
        won_at: lead.won_at,
        history_complete: lead.history_complete,
        // Чем именно сделка попала в период. Нужно, чтобы сделка 2024 года,
        // у которой в августе была встреча или оплата, не выглядела мусором:
        // видно, что она здесь не по ошибке.
        in_period: {
          lead: hits.lead,
          qualified: hits.qualified,
          meetings: hits.meetings,
          contract: hits.contract,
          money: hits.money,
        },
        amo_url: AMO_BASE ? `${AMO_BASE}/leads/detail/${lead.amo_id}` : null,
      }));

    // Срез в 200 строк — не «столько и есть». Отдаём флаг, чтобы UI сказал правду.
    return NextResponse.json({ rows, truncated: rows.length === MAX_ROWS });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'first_sales_leads_failed' },
      { status: 500 },
    );
  }
}

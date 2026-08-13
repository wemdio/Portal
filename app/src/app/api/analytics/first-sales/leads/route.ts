import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { requireFirstSalesAccess } from '@/lib/firstSales/access';
import { parseFirstSalesParams } from '@/lib/firstSales/params';
import { fetchFirstSalesLeads } from '@/lib/firstSales/metrics';
import { fetchMeetingLinks } from '@/lib/firstSales/meetings';
import { resolveSource } from '@/lib/firstSales/sources';

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

  // Сюда приходит КЛЮЧ источника, а не название: `enum_id` строкой, либо
  // `none` для сделок без заполненного «Источник». Именно его кладёт в
  // разбивку metrics.ts, и именно его присылает таблица.
  // Проверяем на `null`, а не на пустоту: отсутствие параметра — это ошибка
  // вызова, а не «источник без имени».
  const source = url.searchParams.get('source');
  if (source === null) {
    return NextResponse.json({ error: 'Нужен параметр source' }, { status: 400 });
  }

  try {
    // Та же ширина выборки, что в summary/route.ts: сделка с привязанной
    // встречей в окне может лежать вне окна по created_at/этапам (пришла
    // раньше). Без этого расширения drill-down источника показал бы меньше
    // сделок, чем summary насчитал встреч для того же источника.
    const meetingLinks = await fetchMeetingLinks(gate.supabaseAdmin, PIPELINE_ID, from, to);
    const meetingDealIds = [...new Set(meetingLinks.map((m) => m.amo_deal_id))];

    const leads = await fetchFirstSalesLeads(
      gate.supabaseAdmin, PIPELINE_ID, from, to, meetingDealIds,
    );

    // Фильтр по источникам здесь НЕ применяется: строка, в которую пользователь
    // проваливается, уже прошла его в сводке — второй раз отсеивать нечего.
    const rows = leads
      .filter((lead) => resolveSource(lead.raw).key === source)
      .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
      .slice(0, MAX_ROWS)
      .map((lead) => ({
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

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { requireFirstSalesAccess } from '@/lib/firstSales/access';
import { parseFirstSalesParams } from '@/lib/firstSales/params';
import { matchesDrill, parseDrillSlice } from '@/lib/firstSales/drill';
import {
  fetchFirstSalesLeads,
  isContractInWindow,
  isSaleInWindow,
  isLeadInWindow,
  isQualifiedInWindow,
  meetingsByDeal,
} from '@/lib/firstSales/metrics';
import { fetchTaskMeetings } from '@/lib/firstSales/meetings';
import { fetchFirstSalesPayments, moneyByDeal } from '@/lib/firstSales/money';
import { fetchStatusesAt } from '@/lib/firstSales/dealTransitions';

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
  const { from, to, cohort, cohortFrom, cohortTo } = parsed.value;

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
    // Выборка расширяется так же, как в summary/route.ts: сделка, заведённая
    // раньше окна, попадает в список, если в окне по ней была встреча,
    // договор, продажа или оплата. Иначе сумма списка не сходилась бы с
    // цифрами строки — март, оплаченный в сентябре, сидел в «Деньгах»
    // сентября, но в сентябрьском списке его не было (решение 25.09.2026).
    // Выборка одна на оба режима: без когорты старые сделки отсеиваются ниже.
    const [payments, taskMeetings] = await Promise.all([
      fetchFirstSalesPayments(gate.supabaseAdmin, PIPELINE_ID, from, to),
      fetchTaskMeetings(gate.supabaseAdmin, PIPELINE_ID, from, to),
    ]);
    const extraDealIds = [
      ...new Set([
        ...payments.map((p) => p.amo_deal_id).filter((id): id is number => id != null),
        ...taskMeetings.keys(),
      ]),
    ];

    const leads = await fetchFirstSalesLeads(gate.supabaseAdmin, PIPELINE_ID, from, to, extraDealIds);

    // Встречи и деньги по сделкам — теми же правилами, что и цифры разбивки
    // (окно, порог достоверности встреч, дедуп «одна сделка — один день»,
    // отсев продлений и спорных платежей). Считаются один раз на запрос.
    const meetings = meetingsByDeal(leads, from, to, taskMeetings);
    const money = moneyByDeal(payments, from, to);

    const selected = leads
      .filter(matchesSlice)
      .map((lead) => ({
        lead,
        // Заведена ли в выбранном периоде — для режима «без когорты». При
        // клике по столбцу графика окно from/to — один день, а период —
        // весь выбранный (cohortFrom/cohortTo, см. params.ts).
        createdInCohort: isLeadInWindow(lead, cohortFrom, cohortTo),
        hits: {
          lead: isLeadInWindow(lead, from, to),
          qualified: isQualifiedInWindow(lead, from, to),
          meetings: meetings.get(lead.amo_id) ?? 0,
          sale: isSaleInWindow(lead, from, to),
          contract: isContractInWindow(lead, from, to),
          money: money.get(lead.amo_id) ?? 0,
        },
      }))
      // В списке — сделки, созданные в периоде, и сделки, заведённые раньше,
      // если в периоде по ним что-то случилось (встреча, договор, продажа,
      // деньги). Квал не проверяем: он засчитывается только сделке,
      // созданной в окне (isQualifiedInWindow).
      //
      // История решения: 08.09.2026 список резали строго по дате создания —
      // старая сделка в нём читалась как сломанный фильтр периода. Это
      // давало обратную беду: «Деньги» строки не сходились со списком. С
      // 25.09.2026 старые сделки возвращены, но помечены «заведена раньше» и
      // несут этап на конец периода, так что сломанным фильтром больше не
      // выглядят.
      //
      // С 26.09.2026 это режим «по когорте». В режиме «без когорты» список —
      // только сделки, заведённые в выбранном периоде (как до 25.09.2026):
      // цифры строки в этом режиме посчитаны лишь по ним (`eventsCount` в
      // metrics.ts), и старая сделка в списке объясняла бы то, чего в строке
      // нет. Попадание в окно проверяется то же, что и по когорте, — важно
      // при клике по столбцу: сделка 3 сентября, оплаченная 15-го, обязана
      // быть в таблице столбца 15 сентября.
      .filter(({ hits, createdInCohort }) => (
        (cohort || createdInCohort)
        && (hits.lead || hits.meetings > 0 || hits.contract || hits.sale || hits.money > 0)
      ));

    // Старые сделки при обрезке не теряем: их мало, и именно они объясняют
    // деньги строки. Новые — свежие сверху, как раньше. Без когорты здесь
    // только сделки выбранного периода; `earlier` непуст лишь при клике по
    // столбцу — сделки, заведённые раньше этого дня, но в периоде.
    const byCreatedDesc = (a: (typeof selected)[number], b: (typeof selected)[number]) =>
      (b.lead.created_at ?? '').localeCompare(a.lead.created_at ?? '');
    const earlier = selected.filter(({ hits }) => !hits.lead).sort(byCreatedDesc);
    const inPeriod = selected.filter(({ hits }) => hits.lead).sort(byCreatedDesc);
    const picked = [...inPeriod.slice(0, Math.max(0, MAX_ROWS - earlier.length)), ...earlier].slice(0, MAX_ROWS);
    const truncated = picked.length < selected.length;

    // Этап на конец периода — по истории переходов, а не текущий: выбран
    // июль — значит, где сделка стояла 31 июля. Для периода, который ещё
    // идёт, это совпадает с текущим этапом.
    const statusAtEnd = await fetchStatusesAt(
      gate.supabaseAdmin,
      picked.map(({ lead }) => ({ amo_id: lead.amo_id, created_at: lead.created_at, status_id: lead.status_id })),
      to,
    );

    const rows = picked
      .map(({ lead, hits, createdInCohort }) => ({
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
        /** Этап AMO на конец выбранного периода. null — этап не определить. */
        status_at_end: statusAtEnd.get(lead.amo_id) ?? null,
        // Что у сделки случилось внутри окна: квал, встреча по записи
        // разговора, договор, деньги. `lead: false` — сделка заведена раньше
        // периода и попала в список по одному из остальных событий.
        //
        // Без когорты `lead` — «заведена в выбранном периоде», а не в окне:
        // при клике по столбцу окно — один день, и сделка начала месяца
        // получила бы метку «заведена раньше», хотя режим как раз говорит,
        // что заведённых раньше в списке нет.
        in_period: {
          lead: cohort ? hits.lead : createdInCohort,
          qualified: hits.qualified,
          meetings: hits.meetings,
          sale: hits.sale,
          contract: hits.contract,
          money: hits.money,
        },
        amo_url: AMO_BASE ? `${AMO_BASE}/leads/detail/${lead.amo_id}` : null,
      }));

    // Срез в 200 строк — не «столько и есть». Отдаём флаг, чтобы UI сказал правду.
    return NextResponse.json({ rows, truncated });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'first_sales_leads_failed' },
      { status: 500 },
    );
  }
}

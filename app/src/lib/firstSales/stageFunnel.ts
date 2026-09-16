import type { SupabaseClient } from '@supabase/supabase-js';

import { chunkArray, IN_CHUNK_SIZE } from '@/lib/cisLeads/batchedQuery';
import { readStatusRef, type StatusRef } from '@/lib/firstSales/dealTransitions';
import { resolveSource } from '@/lib/firstSales/sources';
import type {
  FunnelOutcome,
  FunnelStage,
  RenewalsFunnel,
  RenewalsFunnelDeal,
  RenewalsStageDeals,
} from '@/lib/renewals/funnel';

/**
 * Воронка первички по этапам AMO — «на каком этапе остановилась каждая сделка».
 *
 * Та же схема, что у воронки продлений (lib/renewals/funnel.ts), по решению
 * продаж от 11.09.2026: каждая сделка ровно один раз, на этапе, где стояла в
 * последний день периода. Что случилось после периода, воронку за него не
 * меняет. Прежняя воронка метрик «Лиды → Квал → Встречи → Продажи» смешивала
 * когорту (лиды, квалы) с датами событий (встречи, продажи) и не показывала,
 * где именно застревают сделки.
 *
 * Какие сделки на воронке: заведённые в периоде ИЛИ сдвинутые в нём хотя бы раз
 * — в любой воронке, но в конце периода стоявшие в первичке. Сделка, которую
 * к концу периода уже перенесли в продления, сюда не попадает; сделка, которую
 * перенесли позже, — попадает на своём этапе первички.
 *
 * «Успешно реализовано» и «Закрыто и не реализовано» — исходы, а не ступени:
 * показываются отдельной строкой под воронкой, как «вне пути» у продлений.
 *
 * Доли не показываются: это распределение сделок по этапам, а не вложенная
 * воронка, и сужение фигуры не означает отвал.
 */

/** «Неразобранное» (sort 10) — служебный вход AMO, этапом пути не является. */
const PATH_MIN_SORT = 20;
/** «Успешно реализовано» / «Закрыто и не реализовано» — sort 10000 и выше. */
const SYSTEM_SORT = 10000;

/** PostgREST по умолчанию отдаёт не больше 1000 строк; длинные выборки листаем. */
const PAGE_SIZE = 1000;

const AMO_BASE = (process.env.AMO_BASE_URL ?? '').replace(/\/$/, '');

type StatusRow = { status_id: number; status_name: string | null; sort: number | null };

type LeadRow = {
  amo_id: number;
  name: string | null;
  company_name: string | null;
  responsible_name: string | null;
  amount: number | null;
  status_id: number | null;
  pipeline_id: number | null;
  created_at: string | null;
  raw?: unknown;
};

type EventRow = {
  amo_deal_id: number;
  changed_at: string | null;
  from_value: string | null;
  to_value: string | null;
  after: unknown;
  before: unknown;
};

type PageResult = PromiseLike<{ data: unknown; error: { message: string } | null }>;

async function fetchAllPages<T>(page: (from: number, to: number) => PageResult): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await page(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) return out;
  }
}

export async function fetchFirstSalesStageFunnel(
  db: SupabaseClient,
  pipelineId: number,
  window: { from: Date; to: Date },
  sourceFilter: string[] | null = null,
): Promise<RenewalsFunnel> {
  const fromIso = window.from.toISOString();
  const toIso = window.to.toISOString();
  const toMs = window.to.getTime();
  const allowedSources = sourceFilter && sourceFilter.length > 0 ? new Set(sourceFilter) : null;

  const [statusRes, createdRows, movedRows] = await Promise.all([
    db.from('amo_statuses').select('status_id, status_name, sort').eq('pipeline_id', pipelineId),
    fetchAllPages<{ amo_id: number }>((a, b) =>
      db.from('amo_leads').select('amo_id')
        .gte('created_at', fromIso).lte('created_at', toIso)
        .order('amo_id').range(a, b)),
    fetchAllPages<{ amo_deal_id: number }>((a, b) =>
      db.from('amo_events').select('amo_deal_id')
        .eq('event_type', 'lead_status_changed')
        .gte('changed_at', fromIso).lte('changed_at', toIso)
        .order('id').range(a, b)),
  ]);
  if (statusRes.error) throw new Error(`amo_statuses: ${statusRes.error.message}`);

  const statuses = (statusRes.data ?? []) as StatusRow[];
  const statusById = new Map(statuses.map((s) => [Number(s.status_id), s]));

  const ids = [...new Set([
    ...createdRows.map((r) => Number(r.amo_id)),
    ...movedRows.map((r) => Number(r.amo_deal_id)),
  ])];

  // `raw` тяжёлый и нужен только фильтру по каналу — без фильтра не тянем.
  const leadColumns = `amo_id, name, company_name, responsible_name, amount, status_id, pipeline_id, created_at${allowedSources ? ', raw' : ''}`;

  const [leadChunks, eventChunks] = await Promise.all([
    Promise.all(chunkArray(ids, IN_CHUNK_SIZE).map(async (chunk) => {
      const { data, error } = await db.from('amo_leads').select(leadColumns).in('amo_id', chunk);
      if (error) throw new Error(`amo_leads: ${error.message}`);
      return (data ?? []) as unknown as LeadRow[];
    })),
    // Вся история переходов, а не только внутри окна: этап на конец периода —
    // последний переход ДО его конца, и он мог случиться задолго до начала.
    Promise.all(chunkArray(ids, IN_CHUNK_SIZE).map((chunk) =>
      fetchAllPages<EventRow>((a, b) =>
        db.from('amo_events')
          .select('amo_deal_id, changed_at, from_value, to_value, after:payload->value_after, before:payload->value_before')
          .eq('event_type', 'lead_status_changed')
          .in('amo_deal_id', chunk)
          .order('id').range(a, b)))),
  ]);

  const eventsByDeal = new Map<number, EventRow[]>();
  for (const event of eventChunks.flat()) {
    if (!Number.isFinite(Date.parse(event.changed_at ?? ''))) continue;
    const dealId = Number(event.amo_deal_id);
    const list = eventsByDeal.get(dealId) ?? [];
    list.push(event);
    eventsByDeal.set(dealId, list);
  }
  const timeOf = (e: EventRow) => Date.parse(e.changed_at as string);
  for (const list of eventsByDeal.values()) list.sort((a, b) => timeOf(a) - timeOf(b));

  /**
   * Этап сделки на конец периода: «куда» последнего перехода до конца; если все
   * переходы позже — «откуда» первого; если переходов нет — текущий этап.
   * Воронку берём из события: «Успешно / Закрыто» имеют один номер во всех
   * воронках, и только пара «этап + воронка» говорит, где сделка была тогда.
   */
  const stateAt = (lead: LeadRow): StatusRef | null => {
    const events = eventsByDeal.get(Number(lead.amo_id)) ?? [];
    let last: EventRow | null = null;
    for (const event of events) {
      if (timeOf(event) <= toMs) last = event;
      else break;
    }
    if (last) {
      return readStatusRef({ value_after: last.after }, 'value_after')
        ?? (last.to_value ? { statusId: Number(last.to_value), pipelineId: null } : null);
    }
    if (events.length > 0) {
      const first = events[0]!;
      return readStatusRef({ value_before: first.before }, 'value_before')
        ?? (first.from_value ? { statusId: Number(first.from_value), pipelineId: null } : null);
    }
    return lead.status_id === null
      ? null
      : { statusId: Number(lead.status_id), pipelineId: lead.pipeline_id === null ? null : Number(lead.pipeline_id) };
  };

  const dealsBySort = new Map<number, RenewalsFunnelDeal[]>();
  for (const lead of leadChunks.flat()) {
    const state = stateAt(lead);
    if (state === null) continue;
    // Воронка на конец периода; если событие её не назвало — текущая воронка сделки.
    const pipelineAtEnd = state.pipelineId ?? (lead.pipeline_id === null ? null : Number(lead.pipeline_id));
    if (pipelineAtEnd !== pipelineId) continue;

    const status = statusById.get(state.statusId);
    const sort = status?.sort ?? null;
    if (status === undefined || sort === null || sort < PATH_MIN_SORT) continue;
    if (allowedSources && !allowedSources.has(resolveSource(lead.raw).key)) continue;

    const deal: RenewalsFunnelDeal = {
      amoId: Number(lead.amo_id),
      name: lead.name,
      companyName: lead.company_name,
      responsibleName: lead.responsible_name,
      amount: lead.amount,
      currentStatusName: status.status_name,
      createdAt: lead.created_at,
      outcome: null,
      amoUrl: AMO_BASE ? `${AMO_BASE}/leads/detail/${lead.amo_id}` : null,
    };
    const list = dealsBySort.get(sort) ?? [];
    list.push(deal);
    dealsBySort.set(sort, list);
  }

  const bySort = [...statuses].filter((s) => s.sort !== null).sort((a, b) => (a.sort as number) - (b.sort as number));
  const pathRows = bySort.filter((s) => (s.sort as number) >= PATH_MIN_SORT && (s.sort as number) < SYSTEM_SORT);
  const outcomeRows = bySort.filter((s) => (s.sort as number) >= SYSTEM_SORT);

  const group = (row: StatusRow): RenewalsStageDeals => ({
    statusId: Number(row.status_id),
    name: row.status_name ?? String(row.status_id),
    sort: Number(row.sort),
    deals: dealsBySort.get(Number(row.sort)) ?? [],
  });

  const stages: FunnelStage[] = pathRows.map((row) => ({
    statusId: Number(row.status_id),
    name: row.status_name ?? String(row.status_id),
    sort: Number(row.sort),
    reached: dealsBySort.get(Number(row.sort))?.length ?? 0,
  }));
  const outcomes: FunnelOutcome[] = outcomeRows.map((row) => ({
    statusId: Number(row.status_id),
    name: row.status_name ?? String(row.status_id),
    count: dealsBySort.get(Number(row.sort))?.length ?? 0,
  }));

  let totalDeals = 0;
  for (const deals of dealsBySort.values()) totalDeals += deals.length;

  return {
    pipelineId,
    totalDeals,
    stages,
    outcomes,
    // Бэкфила карточек у первички нет — поле из общей формы ответа.
    backfilledCount: 0,
    dealGroups: pathRows.map(group).filter((g) => g.deals.length > 0),
    outcomeGroups: outcomeRows.map(group).filter((g) => g.deals.length > 0),
  };
}

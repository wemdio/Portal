import type { SupabaseClient } from '@supabase/supabase-js';

import { chunkArray, IN_CHUNK_SIZE } from '@/lib/cisLeads/batchedQuery';

/**
 * Воронка вторичных продаж — из воронки AMO «Вторичные (и не только) продажи».
 *
 * Ступень = сколько сделок СТОЯЛО на этапе в последний день выбранного периода.
 * Каждая сделка ровно один раз. Где она была до и после — видно в карточке
 * сделки (рельсы переходов, см. firstSales/dealTransitions.ts).
 *
 * Почему на конец периода, а не на сегодня. Продлённая 9 сентября nafi.ru в
 * августовской воронке не должна выглядеть продлённой: в августе она была на
 * паузе. Растянули период до 10 сентября — и она переезжает в «Продлено». Так
 * воронка за прошлый месяц не меняется задним числом от того, что случилось
 * после него.
 *
 * Путь сюда был через две другие схемы, и обе путали людей:
 *   * до 10.09.2026 — когорта заведённых в периоде карточек: цикл продления
 *     длиннее месяца, и за август воронка показывала девять сделок на входе и
 *     нули дальше;
 *   * 10–11.09.2026 — входы на этап внутри периода: сделка попадала на каждый
 *     пройденный этап и в одном месяце висела и «на паузе», и «продлена».
 *
 * Какие сделки на воронке: заведённые в периоде или сдвинутые в нём хотя бы
 * раз. Этап у каждой — тот, на котором она стояла в конце периода. Сделка,
 * которая в конце периода была ещё в другой воронке (в первичке), сюда не
 * попадает. Берутся карточки, которые сейчас лежат в воронке продлений:
 * сделку, уведённую отсюда в другую воронку, прошлые периоды не увидят.
 *
 * Воронка при этом не вложенная: это распределение сделок по этапам, и сужение
 * фигуры не означает отвал клиентов. Поэтому доли не показываются.
 */

/** Воронка «Вторичные (и не только) продажи», создана 06.08.2026. */
export const SECONDARY_PIPELINE_ID = Number(process.env.RENEWALS_PIPELINE_ID ?? '11176862');

/**
 * Верхняя граница прямого пути. Этапы выше по `sort` — «Пауза», «Реанимация»,
 * «Отвал / не продлен» — не продолжение пути, а исходы: сделка попадает туда
 * ВМЕСТО продления, а не после него. Считать их ступенями воронки значило бы
 * записать отвалившиеся сделки в продлённые, потому что их `sort` больше.
 */
const PATH_MAX_SORT = 90;

/** Нижняя граница: `sort` 10 — служебное «Неразобранное», входом оно не является. */
const PATH_MIN_SORT = 20;

/** Системные «Успешно реализовано» / «Закрыто и не реализовано». */
const SYSTEM_SORT = 10000;

export interface FunnelStage {
  statusId: number;
  name: string;
  sort: number;
  /**
   * Сколько сделок стояло на этом этапе в последний день периода.
   * Имя поля историческое — осталось со схемы «дошло до этапа», интерфейс
   * графика завязан на него.
   */
  reached: number;
}

export interface FunnelOutcome {
  statusId: number;
  name: string;
  /** Сколько сделок стоят здесь СЕЙЧАС. Исход — состояние, а не пройденный этап. */
  count: number;
}

/** Сделка в списке рядом с воронкой. */
export interface RenewalsFunnelDeal {
  amoId: number;
  name: string | null;
  companyName: string | null;
  responsibleName: string | null;
  amount: number | null;
  /**
   * Этап сделки на последний день периода (имя поля историческое). Для периода,
   * который кончается сегодня, это и есть текущий этап.
   */
  currentStatusName: string | null;
  /** Дата заведения сделки. */
  createdAt: string | null;
  /**
   * Значок исхода в строке. С 11.09.2026 всегда null: сделка стоит в группе
   * своего текущего этапа, и сделка на паузе лежит в группе «Пауза», а не в
   * ступени пути со значком. Поле оставлено, чтобы не трогать форму ответа.
   */
  outcome: string | null;
  amoUrl: string | null;
}

/**
 * Сделки, сгруппированные по этапу на последний день периода: каждая ровно один
 * раз. Длина группы совпадает с числом на ступени — они считаются из одной и
 * той же карты.
 */
export interface RenewalsStageDeals {
  statusId: number;
  name: string;
  sort: number;
  deals: RenewalsFunnelDeal[];
}

export interface RenewalsFunnel {
  pipelineId: number;
  /** Сколько сделок на воронке — на ступенях пути и в исходах вместе. */
  totalDeals: number;
  stages: FunnelStage[];
  outcomes: FunnelOutcome[];
  /**
   * Карточки, заведённые задним числом по портальным проектам: продления,
   * случившиеся до появления воронки.
   *
   * В ступени они не входят: их создали сразу на «Продлено» по данным портала,
   * и в работе через воронку они не были. Продлены они по-настоящему, поэтому
   * показываются отдельным числом, а не прячутся.
   */
  backfilledCount: number;
  /** Те же сделки, что стоят за ступенями, — списком (см. RenewalsStageDeals). */
  dealGroups: RenewalsStageDeals[];
  /**
   * Сделки вне пути («Пауза», «Реанимация», «Отвал / не продлен»), которые
   * стояли там в последний день периода, — раскрывают цифры `outcomes` в карточки.
   */
  outcomeGroups: RenewalsStageDeals[];
}

interface StatusRow {
  status_id: number;
  status_name: string | null;
  sort: number | null;
}

interface LeadRow {
  amo_id: number;
  status_id: number | null;
  name: string | null;
  company_name: string | null;
  responsible_name: string | null;
  amount: number | null;
  status_name: string | null;
  created_at: string | null;
}

const AMO_BASE = (process.env.AMO_BASE_URL ?? '').replace(/\/$/, '');

/**
 * Окно периода. `from` отбирает сделки (заведены или сдвинуты в окне), `to` —
 * момент, на который берётся их этап.
 */
export interface FunnelWindow { from: Date; to: Date }

type StatusRef = { statusId: number; pipelineId: number | null };

/** Пара «этап + воронка» из `payload.value_before` / `value_after` события AMO. */
function readStatusRef(payload: unknown, side: 'value_before' | 'value_after'): StatusRef | null {
  if (payload === null || typeof payload !== 'object') return null;
  const list = (payload as Record<string, unknown>)[side];
  if (!Array.isArray(list) || list.length === 0) return null;
  const status = (list[0] as { lead_status?: { id?: unknown; pipeline_id?: unknown } } | null)?.lead_status;
  const statusId = Number(status?.id);
  if (!Number.isFinite(statusId)) return null;
  const pipelineId = Number(status?.pipeline_id);
  return { statusId, pipelineId: Number.isFinite(pipelineId) ? pipelineId : null };
}

type EventRow = {
  amo_deal_id: number;
  changed_at: string | null;
  from_value: string | null;
  to_value: string | null;
  payload: unknown;
};

export async function fetchRenewalsFunnel(
  db: SupabaseClient,
  window?: FunnelWindow,
): Promise<RenewalsFunnel> {
  const { data: statusData, error: statusError } = await db
    .from('amo_statuses')
    .select('status_id, status_name, sort')
    .eq('pipeline_id', SECONDARY_PIPELINE_ID);
  if (statusError) throw new Error(`amo_statuses: ${statusError.message}`);

  const statuses = (statusData ?? []) as StatusRow[];
  const statusById = new Map<number, StatusRow>();
  for (const row of statuses) statusById.set(Number(row.status_id), row);

  const { data: leadData, error: leadError } = await db
    .from('amo_leads')
    .select('amo_id, status_id, name, company_name, responsible_name, amount, status_name, created_at')
    .eq('pipeline_id', SECONDARY_PIPELINE_ID);
  if (leadError) throw new Error(`amo_leads: ${leadError.message}`);

  const allLeads = (leadData ?? []) as LeadRow[];

  // Карточки, заведённые задним числом скриптом бэкфилла, помечены в таблице
  // связей — по ней их и отличаем. Отдельного признака в самой сделке нет и
  // заводить его в AMO не нужно: пометка и так живёт на нашей стороне.
  const { data: backfillData, error: backfillError } = await db
    .from('attribution_amo_project')
    .select('amo_deal_id')
    .eq('method', 'renewal_backfill');
  if (backfillError) throw new Error(`attribution_amo_project: ${backfillError.message}`);

  const backfilled = new Set(
    ((backfillData ?? []) as { amo_deal_id: number }[]).map((r) => Number(r.amo_deal_id)),
  );

  const leads = allLeads.filter((l) => !backfilled.has(l.amo_id));
  const backfilledCount = allLeads.length - leads.length;

  // Момент, на который берётся этап. Без окна — сегодня, то есть текущий этап.
  const asOfMs = (window?.to ?? new Date()).getTime();
  const fromMs = window ? window.from.getTime() : Number.NEGATIVE_INFINITY;
  const timeOf = (iso: string | null) => (iso ? new Date(iso).getTime() : Number.NaN);

  // Вся история переходов, а не только внутри окна: этап на конец периода —
  // это последний переход ДО его конца, и он мог случиться задолго до начала.
  const eventsByDeal = new Map<number, EventRow[]>();
  if (leads.length > 0) {
    const ids = leads.map((l) => l.amo_id);
    for (const chunk of chunkArray(ids, IN_CHUNK_SIZE)) {
      const { data: eventData, error: eventError } = await db
        .from('amo_events')
        .select('amo_deal_id, changed_at, from_value, to_value, payload')
        .eq('event_type', 'lead_status_changed')
        .in('amo_deal_id', chunk);
      if (eventError) throw new Error(`amo_events: ${eventError.message}`);
      for (const event of (eventData ?? []) as EventRow[]) {
        if (!Number.isFinite(timeOf(event.changed_at))) continue;
        const dealId = Number(event.amo_deal_id);
        const list = eventsByDeal.get(dealId) ?? [];
        list.push(event);
        eventsByDeal.set(dealId, list);
      }
    }
    for (const list of eventsByDeal.values()) {
      list.sort((a, b) => timeOf(a.changed_at) - timeOf(b.changed_at));
    }
  }

  /**
   * Этап сделки на конец периода. Последний переход до конца — его «куда». Если
   * все переходы случились позже, сделка стояла там, откуда ушла первым из них.
   * Если переходов нет вовсе — там, где стоит сейчас.
   *
   * Воронку берём из события: «Успешно реализовано» и «Закрыто» имеют один
   * номер во всех воронках, и только пара «этап + воронка» говорит, была ли
   * сделка в конце периода уже здесь или ещё в первичке.
   */
  const stateAt = (lead: LeadRow): StatusRef | null => {
    const events = eventsByDeal.get(Number(lead.amo_id)) ?? [];
    let last: EventRow | null = null;
    for (const event of events) {
      if (timeOf(event.changed_at) <= asOfMs) last = event;
      else break;
    }
    if (last) {
      return readStatusRef(last.payload, 'value_after')
        ?? (last.to_value ? { statusId: Number(last.to_value), pipelineId: null } : null);
    }
    if (events.length > 0) {
      const first = events[0]!;
      return readStatusRef(first.payload, 'value_before')
        ?? (first.from_value ? { statusId: Number(first.from_value), pipelineId: null } : null);
    }
    return lead.status_id === null ? null : { statusId: Number(lead.status_id), pipelineId: SECONDARY_PIPELINE_ID };
  };

  const toFunnelDeal = (lead: LeadRow, stageName: string | null): RenewalsFunnelDeal => ({
    amoId: Number(lead.amo_id),
    name: lead.name,
    companyName: lead.company_name,
    responsibleName: lead.responsible_name,
    amount: lead.amount,
    currentStatusName: stageName,
    createdAt: lead.created_at,
    outcome: null,
    amoUrl: AMO_BASE ? `${AMO_BASE}/leads/detail/${lead.amo_id}` : null,
  });

  // Одна карта «этап на конец периода → сделки» кормит и ступени, и исходы, и
  // оба списка: цифра на ступени и длина группы разойтись не могут.
  const dealsBySort = new Map<number, RenewalsFunnelDeal[]>();
  for (const lead of leads) {
    const createdMs = timeOf(lead.created_at);
    // Сделки на конец периода ещё не существовало.
    if (window !== undefined && !(createdMs <= asOfMs)) continue;

    const events = eventsByDeal.get(Number(lead.amo_id)) ?? [];
    const activeInPeriod =
      window === undefined
      || (createdMs >= fromMs && createdMs <= asOfMs)
      || events.some((e) => {
        const t = timeOf(e.changed_at);
        return t >= fromMs && t <= asOfMs;
      });
    if (!activeInPeriod) continue;

    const state = stateAt(lead);
    if (state === null) continue;
    // В конце периода сделка была ещё в другой воронке — здесь её тогда не было.
    if (state.pipelineId !== null && state.pipelineId !== SECONDARY_PIPELINE_ID) continue;

    const status = statusById.get(state.statusId);
    const sort = status?.sort ?? undefined;
    // «Неразобранное» и системные «Успешно / Закрыто» — не этапы этой воронки,
    // ни ступенью, ни исходом их не покажешь.
    if (status === undefined || sort === undefined || sort < PATH_MIN_SORT || sort >= SYSTEM_SORT) continue;

    const list = dealsBySort.get(sort) ?? [];
    list.push(toFunnelDeal(lead, status.status_name));
    dealsBySort.set(sort, list);
  }

  const countAt = (sort: number) => dealsBySort.get(sort)?.length ?? 0;

  const stages: FunnelStage[] = statuses
    .filter((row) => row.sort !== null && row.sort >= PATH_MIN_SORT && row.sort <= PATH_MAX_SORT)
    .sort((a, b) => (a.sort as number) - (b.sort as number))
    .map((row) => ({
      statusId: Number(row.status_id),
      name: row.status_name ?? String(row.status_id),
      sort: Number(row.sort),
      reached: countAt(Number(row.sort)),
    }));

  const outcomeRows = statuses
    .filter((row) => row.sort !== null && row.sort > PATH_MAX_SORT && row.sort < SYSTEM_SORT)
    .sort((a, b) => (a.sort as number) - (b.sort as number));

  const outcomes: FunnelOutcome[] = outcomeRows.map((row) => ({
    statusId: Number(row.status_id),
    name: row.status_name ?? String(row.status_id),
    count: countAt(Number(row.sort)),
  }));

  const nameBySort = new Map<number, StatusRow>();
  for (const row of statuses) {
    if (row.sort !== null) nameBySort.set(Number(row.sort), row);
  }

  const dealGroups: RenewalsStageDeals[] = [...dealsBySort.entries()]
    .filter(([sort]) => sort <= PATH_MAX_SORT)
    .sort(([a], [b]) => a - b)
    .map(([sort, deals]) => {
      const status = nameBySort.get(sort);
      return {
        statusId: status ? Number(status.status_id) : sort,
        name: status?.status_name ?? String(sort),
        sort,
        deals,
      };
    });

  const outcomeGroups: RenewalsStageDeals[] = outcomeRows
    .map((row) => ({
      statusId: Number(row.status_id),
      name: row.status_name ?? String(row.status_id),
      sort: Number(row.sort),
      deals: dealsBySort.get(Number(row.sort)) ?? [],
    }))
    .filter((group) => group.deals.length > 0);

  let totalDeals = 0;
  for (const deals of dealsBySort.values()) totalDeals += deals.length;

  return {
    pipelineId: SECONDARY_PIPELINE_ID,
    totalDeals,
    stages,
    outcomes,
    backfilledCount,
    dealGroups,
    outcomeGroups,
  };
}

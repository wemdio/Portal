import type { SupabaseClient } from '@supabase/supabase-js';

import { chunkArray, IN_CHUNK_SIZE } from '@/lib/cisLeads/batchedQuery';

/**
 * Воронка вторичных продаж — из воронки AMO «Вторичные (и не только) продажи».
 *
 * Ступень = «сколько сделок вошло на этот этап ВНУТРИ периода», а не когорта
 * заведённых в периоде карточек (так было до 10.09.2026).
 *
 * Почему переключили. Цикл продления — месяцы: клиента заводят в воронку
 * задолго до оплаты. Когортная воронка за август показывала девять сделок,
 * застрявших на первом этапе, и нули дальше, — при том что в том же августе
 * три сделки дошли до «Продлено», две получили счёт, три обсуждали продление.
 * Вся работа месяца шла по карточкам прошлых месяцев и в воронку не попадала,
 * а плитка «Продлений — 3» рядом ей открыто противоречила.
 *
 * Плата за это — вложенности больше нет: сделка могла обсуждать продление в
 * июле, а продлиться в августе, и в августовской воронке она есть только на
 * «Продлено». Поэтому ступени показывают количества, а доли «сколько дошло от
 * предыдущего этапа» с экрана убраны — они врали бы.
 *
 * История берётся из `amo_events` (`lead_status_changed`, `to_value` — номер
 * этапа строкой). Карточка, заведённая внутри окна и ни разу не сдвинутая,
 * событий не имеет вовсе — её засчитываем на текущем этапе: иначе новые сделки
 * месяца пропали бы с экрана целиком.
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
  /** Сколько сделок дошли до этого этапа хотя бы раз. */
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
  /** Этап, на котором сделка стоит СЕЙЧАС. */
  currentStatusName: string | null;
  /** Дата заведения сделки — по ней сделка и попала в период. */
  createdAt: string | null;
  /** Заполнено, если сделка сейчас вне пути: пауза, реанимация, отвал. */
  outcome: string | null;
  amoUrl: string | null;
}

/**
 * Сделки, сгруппированные по САМОМУ ГЛУБОКОМУ пройденному этапу.
 *
 * Не «сколько стоит на этапе сейчас» и не «дошло до этапа» (второе даёт
 * вложенные множества, и сделка попала бы в каждую группу разом). Здесь каждая
 * сделка ровно один раз — там, где остановилась, — так же, как в списке рядом
 * с воронкой первички.
 *
 * Сделка, уехавшая в паузу или отвал, остаётся в своей ступени пути: путь она
 * прошла, а исход виден отдельным значком в строке. Иначе половина списка
 * провалилась бы в исходы, и стало бы не видно, докуда именно дошли.
 */
export interface RenewalsStageDeals {
  statusId: number;
  name: string;
  sort: number;
  deals: RenewalsFunnelDeal[];
}

export interface RenewalsFunnel {
  pipelineId: number;
  /** Сделок, участвующих в воронке, — знаменатель для долей. */
  totalDeals: number;
  stages: FunnelStage[];
  outcomes: FunnelOutcome[];
  /**
   * Карточки, заведённые задним числом по портальным проектам: продления,
   * случившиеся до появления воронки.
   *
   * В ступени они не входят и это не придирка. Их создали сразу на «Продлено»,
   * они не проходили ни онбординг, ни обсуждение — а расчёт «дошло до этапа»
   * засчитал бы им все предыдущие ступени, и воронка выродилась бы в
   * прямоугольник со стопроцентной конверсией на каждом шаге. Продлены они при
   * этом по-настоящему, поэтому показываются отдельным числом, а не прячутся.
   */
  backfilledCount: number;
  /** Те же сделки, что стоят за ступенями, — списком (см. RenewalsStageDeals). */
  dealGroups: RenewalsStageDeals[];
  /**
   * Сделки вне пути («Пауза», «Реанимация», «Отвал / не продлен»), сгруппированные
   * по текущему исходу, — раскрывают цифры из `outcomes` в конкретные карточки.
   *
   * Ключ — ТЕКУЩИЙ этап, как и у `outcomes`: пауза, из которой проект вернулся
   * в работу, здесь уже не пауза. В `dealGroups` сделка при этом остаётся в
   * своей ступени с значком исхода — там вопрос «докуда дошла», здесь «кто
   * стоит вне пути сейчас». Дубль в двух списках осознанный.
   *
   * Входит и сделка, не прошедшая ни одного этапа пути (например, уехавшая в
   * отвал из «Неразобранного»): в ступенях ей нет места, а здесь она видна —
   * иначе цифра исхода и список расходились бы.
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
 * Окно периода. Считаются переходы на этапы внутри окна плюс карточки,
 * заведённые в окне и ещё не сдвинутые с места (у них событий нет). Дата
 * заведения карточки сама по себе в отбор не входит — см. шапку файла.
 */
export interface FunnelWindow { from: Date; to: Date }

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
  const sortById = new Map<number, number>();
  for (const row of statuses) {
    if (row.sort !== null) sortById.set(Number(row.status_id), Number(row.sort));
  }

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
  const leadById = new Map<number, LeadRow>(leads.map((l) => [Number(l.amo_id), l]));

  const createdInWindow = (lead: LeadRow): boolean => {
    if (window === undefined) return true;
    if (!lead.created_at) return false;
    const t = new Date(lead.created_at).getTime();
    return Number.isFinite(t) && t >= window.from.getTime() && t <= window.to.getTime();
  };

  const changedInWindow = (changedAt: string | null): boolean => {
    if (window === undefined) return true;
    if (!changedAt) return false;
    const t = new Date(changedAt).getTime();
    return Number.isFinite(t) && t >= window.from.getTime() && t <= window.to.getTime();
  };

  /** Сделка → номера этапов (`sort`), на которые она вошла внутри окна. */
  const enteredSorts = new Map<number, Set<number>>();
  const addEntry = (dealId: number, sort: number) => {
    const set = enteredSorts.get(dealId) ?? new Set<number>();
    set.add(sort);
    enteredSorts.set(dealId, set);
  };

  /** Двигали ли сделку вообще — чтобы отличить «стоит с рождения» от «двигали вне окна». */
  const everMoved = new Set<number>();

  if (leads.length > 0) {
    const ids = leads.map((l) => l.amo_id);
    for (const chunk of chunkArray(ids, IN_CHUNK_SIZE)) {
      const { data: eventData, error: eventError } = await db
        .from('amo_events')
        .select('amo_deal_id, to_value, changed_at')
        .eq('event_type', 'lead_status_changed')
        .in('amo_deal_id', chunk);
      if (eventError) throw new Error(`amo_events: ${eventError.message}`);

      const rows = (eventData ?? []) as {
        amo_deal_id: number;
        to_value: string | null;
        changed_at: string | null;
      }[];

      for (const event of rows) {
        if (!event.to_value) continue;
        const sort = sortById.get(Number(event.to_value));
        // Чужие воронки отсеиваются сами: их номеров нет в `sortById`.
        // Системные «Успешно реализовано» / «Закрыто и не реализовано» тоже
        // не показываем — они не этап этой воронки.
        if (sort === undefined || sort >= SYSTEM_SORT) continue;
        const dealId = Number(event.amo_deal_id);
        everMoved.add(dealId);
        if (!changedInWindow(event.changed_at)) continue;
        addEntry(dealId, sort);
      }
    }
  }

  // Карточка, заведённая внутри окна и ни разу не сдвинутая, событий не имеет —
  // засчитываем её на том этапе, где она стоит. Без этого новые сделки месяца
  // исчезли бы с воронки целиком, хотя в работу они как раз попали.
  for (const lead of leads) {
    const dealId = Number(lead.amo_id);
    if (everMoved.has(dealId)) continue;
    if (!createdInWindow(lead)) continue;
    const sort = lead.status_id === null ? undefined : sortById.get(Number(lead.status_id));
    if (sort === undefined || sort >= SYSTEM_SORT) continue;
    addEntry(dealId, sort);
  }

  const countBySort = new Map<number, number>();
  for (const sorts of enteredSorts.values()) {
    for (const sort of sorts) countBySort.set(sort, (countBySort.get(sort) ?? 0) + 1);
  }

  const stages: FunnelStage[] = statuses
    .filter((row) => row.sort !== null && row.sort >= PATH_MIN_SORT && row.sort <= PATH_MAX_SORT)
    .sort((a, b) => (a.sort as number) - (b.sort as number))
    .map((row) => ({
      statusId: Number(row.status_id),
      name: row.status_name ?? String(row.status_id),
      sort: Number(row.sort),
      reached: countBySort.get(Number(row.sort)) ?? 0,
    }));

  // Исходы — тем же правилом, что и ступени: сколько сделок ушло в паузу,
  // реанимацию или отвал ВНУТРИ окна. Считать их по «стоит сейчас» нельзя —
  // это цифра на сегодня, а не за период, и с остальным экраном она спорила бы.
  const outcomes: FunnelOutcome[] = statuses
    .filter((row) => row.sort !== null && row.sort > PATH_MAX_SORT && row.sort < SYSTEM_SORT)
    .sort((a, b) => (a.sort as number) - (b.sort as number))
    .map((row) => ({
      statusId: Number(row.status_id),
      name: row.status_name ?? String(row.status_id),
      count: countBySort.get(Number(row.sort)) ?? 0,
    }));

  // Список сделок под ступенями: та же карта maxPathSort, что и у ступеней, —
  // значит длина группы и цифра на ступени посчитаны из одного источника и
  // разойтись не могут.
  const nameBySort = new Map<number, StatusRow>();
  for (const row of statuses) {
    if (row.sort !== null) nameBySort.set(Number(row.sort), row);
  }

  const toFunnelDeal = (lead: LeadRow, outcome: string | null): RenewalsFunnelDeal => ({
    amoId: Number(lead.amo_id),
    name: lead.name,
    companyName: lead.company_name,
    responsibleName: lead.responsible_name,
    amount: lead.amount,
    currentStatusName: lead.status_name,
    createdAt: lead.created_at,
    outcome,
    amoUrl: AMO_BASE ? `${AMO_BASE}/leads/detail/${lead.amo_id}` : null,
  });

  // Сделка попадает в группу КАЖДОГО этапа, на который вошла внутри окна: за
  // месяц она могла и обсуждаться, и получить счёт, и продлиться. Так длина
  // группы совпадает с цифрой на ступени — они считаются из одной карты.
  const dealsBySort = new Map<number, RenewalsFunnelDeal[]>();
  for (const [dealId, sorts] of enteredSorts.entries()) {
    const lead = leadById.get(dealId);
    if (lead === undefined) continue;
    const currentSort = lead.status_id === null ? undefined : sortById.get(Number(lead.status_id));
    for (const sort of sorts) {
      // Этапы ниже входа («Неразобранное») на воронке не показываются —
      // значит и в списке им не место. Исходы идут своими группами ниже.
      if (sort < PATH_MIN_SORT || sort > PATH_MAX_SORT) continue;
      const list = dealsBySort.get(sort) ?? [];
      list.push(
        // Исход — состояние, а не пройденный этап: сделка стоит там СЕЙЧАС.
        toFunnelDeal(
          lead,
          currentSort !== undefined && currentSort > PATH_MAX_SORT && currentSort < SYSTEM_SORT
            ? lead.status_name
            : null,
        ),
      );
      dealsBySort.set(sort, list);
    }
  }

  const dealGroups: RenewalsStageDeals[] = [...dealsBySort.entries()]
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

  // Раскрываем исходы в конкретные сделки — по текущему этапу, как и сами
  // цифры исходов, чтобы список и воронка не могли разойтись.
  const outcomeDeals = new Map<number, RenewalsFunnelDeal[]>();
  for (const [dealId, sorts] of enteredSorts.entries()) {
    const lead = leadById.get(dealId);
    if (lead === undefined) continue;
    for (const sort of sorts) {
      if (sort <= PATH_MAX_SORT || sort >= SYSTEM_SORT) continue;
      const list = outcomeDeals.get(sort) ?? [];
      // outcome тут не нужен: имя группы уже называет исход, значок в строке
      // был бы повтором.
      list.push(toFunnelDeal(lead, null));
      outcomeDeals.set(sort, list);
    }
  }

  const outcomeGroups: RenewalsStageDeals[] = statuses
    .filter((row) => row.sort !== null && row.sort > PATH_MAX_SORT && row.sort < SYSTEM_SORT)
    .sort((a, b) => (a.sort as number) - (b.sort as number))
    .map((row) => ({
      statusId: Number(row.status_id),
      name: row.status_name ?? String(row.status_id),
      sort: Number(row.sort),
      deals: outcomeDeals.get(Number(row.sort)) ?? [],
    }))
    .filter((group) => group.deals.length > 0);

  return {
    pipelineId: SECONDARY_PIPELINE_ID,
    // Сколько РАЗНЫХ сделок засветилось в периоде хоть одним этапом. Прежнее
    // `leads.length` было размером когорты и после переключения означало бы
    // «все сделки воронки за всю историю».
    totalDeals: enteredSorts.size,
    stages,
    outcomes,
    backfilledCount,
    dealGroups,
    outcomeGroups,
  };
}

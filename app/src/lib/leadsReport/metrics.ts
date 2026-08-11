import type { SupabaseClient } from '@supabase/supabase-js';
import { chunkArray, IN_CHUNK_SIZE } from '@/lib/cisLeads/batchedQuery';
import {
  detectSummaryChannel,
  type ChannelSummaryConfig,
} from '@/lib/leadsReport/channels';
import { extractCustomField } from '@/lib/leadsReport/extractCustomField';
import {
  dedupeLeadMagnets,
  isExcludedLeadName,
  isLeadMagnet,
  type DedupCandidate,
} from '@/lib/leadsReport/leadFilters';

const DEFAULT_PIPELINE_NAME = 'Воронка - новые лиды';
const QUALIFIED_STATUS = 'Квалифицированный лид';
const MEETING_SCHEDULED_STATUS = 'Назначена встреча';
const MEETING_HELD_STATUS = 'Встреча проведена + КП отправлено';
const PARKING_STATUS = 'Перенос';
const WON_STATUS_ID = 142;
const LOST_STATUS_ID = 143;

/**
 * `identity` для дедупа лид-магнита — кастомное поле AMO «Telegram Chat ID»,
 * точный признак «тот же человек». Заполнено примерно у половины заявок бота;
 * где пусто, `dedupeLeadMagnets` откатывается на имя. Без него под именем
 * «Бот: Георгий» схлопнулись бы три разных телеграм-аккаунта.
 */
const TELEGRAM_CHAT_ID_FIELD = 'Telegram Chat ID';

const normalize = (value: string | null): string =>
  (value ?? '').trim().toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');

export type AmoStatusMetricRow = {
  pipeline_id: number;
  status_id: number;
  status_name: string;
  sort: number;
};

export type AmoLeadMetricRow = {
  amo_id: number;
  pipeline_id: number | null;
  status_id: number | null;
  name: string | null;
  created_at: string | null;
  raw: unknown;
};

/** Переход этапа из `amo_events` (`event_type = 'lead_status_changed'`). */
export type AmoStatusEventRow = {
  amo_deal_id: number;
  changed_at: string;
  from_value: string | null;
  to_value: string | null;
};

export type ChannelMetrics = {
  channel: ChannelSummaryConfig;
  arrived: number;
  qualifiedLeads: number;
  meetingsScheduled: number;
  meetingsHeld: number;
};

type Thresholds = {
  pipelineId: number;
  qualifiedSort: number;
  meetingScheduledSort: number;
  meetingHeldSort: number;
  sortByStatusId: Map<number, number>;
  /**
   * Статусы, которые НЕ считаются достигнутым этапом воронки.
   *
   * «Успешно» и «Закрыто» — потому что их sort (10000/11000) это признак
   * закрытия, а не позиция. «Перенос» — потому что это парковка: карточку
   * кладут туда с любого этапа, а лежит она в воронке выше «Встречи
   * проведённой». Без этого исключения правило «максимум за неделю» само себя
   * ломает и все придуманные встречи возвращаются.
   */
  ignoredForPeak: Set<number>;
};

function findStatus(
  statuses: AmoStatusMetricRow[],
  name: string,
): AmoStatusMetricRow {
  const found = statuses.find(
    (status) => normalize(status.status_name) === normalize(name),
  );
  if (!found) throw new Error(`AMO status not found: ${name}`);
  return found;
}

function buildThresholds(statuses: AmoStatusMetricRow[]): Thresholds {
  const qualified = findStatus(statuses, QUALIFIED_STATUS);
  const meetingScheduled = findStatus(statuses, MEETING_SCHEDULED_STATUS);
  const meetingHeld = findStatus(statuses, MEETING_HELD_STATUS);
  const parking = findStatus(statuses, PARKING_STATUS);

  const pipelineIds = new Set(
    [qualified, meetingScheduled, meetingHeld, parking].map(
      (status) => status.pipeline_id,
    ),
  );
  if (pipelineIds.size > 1) {
    throw new Error('AMO report statuses belong to different pipelines');
  }

  return {
    pipelineId: qualified.pipeline_id,
    qualifiedSort: qualified.sort,
    meetingScheduledSort: meetingScheduled.sort,
    meetingHeldSort: meetingHeld.sort,
    sortByStatusId: new Map(
      statuses
        .filter((status) => status.pipeline_id === qualified.pipeline_id)
        .map((status) => [status.status_id, status.sort]),
    ),
    ignoredForPeak: new Set([WON_STATUS_ID, LOST_STATUS_ID, parking.status_id]),
  };
}

function isInWindow(value: string | null, start: Date, end: Date): boolean {
  if (!value) return false;
  const time = new Date(value).getTime();
  return Number.isFinite(time) && time >= start.getTime() && time < end.getTime();
}

/**
 * Самый дальний этап воронки, до которого сделка реально дошла к концу окна.
 *
 * Считается из двух источников:
 *   1. этап, на котором карточку создали — `from_value` самого раннего перехода,
 *      а если переходов нет вовсе, значит карточку с тех пор не двигали и это
 *      её текущий этап;
 *   2. все `to_value` переходов, случившихся ДО конца окна.
 *
 * Переходы после конца окна игнорируются: отчёт должен показывать состояние на
 * момент отправки, а не на момент пересчёта. Иначе сделка, у которой встречу
 * назначили через три дня после отчёта, задним числом попадала бы в него.
 */
function computePeak(
  lead: AmoLeadMetricRow,
  events: AmoStatusEventRow[],
  thresholds: Thresholds,
  end: Date,
): number {
  const sortOf = (statusId: number | null): number => {
    if (statusId === null || thresholds.ignoredForPeak.has(statusId)) return 0;
    return thresholds.sortByStatusId.get(statusId) ?? 0;
  };

  const sorted = [...events].sort(
    (a, b) => Date.parse(a.changed_at) - Date.parse(b.changed_at),
  );
  const creationStatusId = sorted.length > 0
    ? toStatusId(sorted[0].from_value)
    : lead.status_id;

  let peak = sortOf(creationStatusId);
  for (const event of sorted) {
    const changedAt = Date.parse(event.changed_at);
    if (!Number.isFinite(changedAt) || changedAt >= end.getTime()) continue;
    peak = Math.max(peak, sortOf(toStatusId(event.to_value)));
  }
  return peak;
}

function toStatusId(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * Успешно закрыта к концу окна.
 *
 * Отдельно от `peak`, потому что «Успешно» (142) намеренно исключён из
 * максимума: его sort — признак закрытия, а не позиция в воронке. Но лидом
 * выигранная сделка является всегда, до «Успешно» иначе не доходят.
 *
 * Карточка без единого перехода — это карточка, которую с момента создания не
 * двигали: её текущий статус и есть статус на конец окна.
 */
function isWonByEnd(
  lead: AmoLeadMetricRow,
  events: AmoStatusEventRow[],
  end: Date,
): boolean {
  if (events.length === 0) return lead.status_id === WON_STATUS_ID;
  return events.some((event) => {
    const changedAt = Date.parse(event.changed_at);
    return Number.isFinite(changedAt)
      && changedAt < end.getTime()
      && toStatusId(event.to_value) === WON_STATUS_ID;
  });
}

/** Чистая часть расчёта — используется тестами и DB-оркестратором. */
export function computeMetricsFromRows(
  channels: ChannelSummaryConfig[],
  statuses: AmoStatusMetricRow[],
  leads: AmoLeadMetricRow[],
  statusEvents: AmoStatusEventRow[],
  start: Date,
  end: Date,
): ChannelMetrics[] {
  const thresholds = buildThresholds(statuses);
  const metrics = new Map(
    channels.map((channel) => [
      channel.name,
      {
        channel,
        arrived: 0,
        qualifiedLeads: 0,
        meetingsScheduled: 0,
        meetingsHeld: 0,
      },
    ]),
  );

  const eventsByDeal = new Map<number, AmoStatusEventRow[]>();
  for (const event of statusEvents) {
    const bucket = eventsByDeal.get(event.amo_deal_id);
    if (bucket) bucket.push(event);
    else eventsByDeal.set(event.amo_deal_id, [event]);
  }

  type PreparedLead = Omit<DedupCandidate, 'channel'> & {
    channel: ChannelSummaryConfig['name'];
  };

  const prepared: PreparedLead[] = [];
  for (const lead of leads) {
    if (lead.pipeline_id !== thresholds.pipelineId) continue;
    const channel = detectSummaryChannel(lead.raw);
    if (!channel || !metrics.has(channel)) continue;

    // Все метрики считаются ТОЛЬКО по сделкам, ПРИШЕДШИМ на этой неделе
    // (created_at в окне). Старые backlog-сделки с активностью на этой неделе
    // не считаются: иначе массовые обновления полей раздуют цифры и они станут
    // несопоставимы с прошлыми отчётами продаж (Егор, 2026-07-24; подтверждено
    // Дмитрием 10.08.2026).
    if (!isInWindow(lead.created_at, start, end)) continue;

    // Свои люди, тестирующие бота и форму, не считаются нигде и ни в одном
    // канале — см. EXCLUDED_LEAD_NAMES.
    if (isExcludedLeadName(lead.name)) continue;

    const leadEvents = eventsByDeal.get(lead.amo_id) ?? [];
    prepared.push({
      amoId: lead.amo_id,
      name: lead.name,
      identity: extractCustomField(lead.raw, TELEGRAM_CHAT_ID_FIELD),
      channel,
      createdAt: lead.created_at,
      wonByEnd: isWonByEnd(lead, leadEvents, end),
      peak: computePeak(lead, leadEvents, thresholds, end),
    });
  }

  for (const item of dedupeLeadMagnets(prepared)) {
    const bucket = metrics.get(item.channel);
    if (!bucket) continue;

    // Лидом считается сделка, дошедшая до «Квалифицированный лид» или дальше.
    // Успешно закрытая — лид всегда: до «Успешно» иначе не доходят.
    const qualified = item.peak >= thresholds.qualifiedSort || item.wonByEnd;

    // Лид-магниты («Бот:...») попадают в «Пришло» только когда прошли
    // квалификацию — иначе они раздувают воронку, ведь бот создаёт много
    // слабых заявок «через магнит» (см. Егор, 2026-07-24).
    if (!isLeadMagnet(item.name) || qualified) {
      bucket.arrived += 1;
    }

    if (qualified) {
      bucket.qualifiedLeads += 1;
    }

    if (item.peak >= thresholds.meetingHeldSort) {
      bucket.meetingsHeld += 1;
    } else if (item.peak >= thresholds.meetingScheduledSort) {
      // Встреча запланирована — дошли до «Назначена встреча», но не до
      // проведённой. Сюда же попадает «Не вышел на звонок»: встречу назначали,
      // клиент не пришёл.
      bucket.meetingsScheduled += 1;
    }
  }

  return channels.map((channel) => {
    const value = metrics.get(channel.name);
    if (!value) throw new Error(`Metrics bucket missing: ${channel.name}`);
    return value;
  });
}

export async function computeAllChannelMetrics(
  db: SupabaseClient,
  channels: ChannelSummaryConfig[],
  start: Date,
  end: Date,
): Promise<ChannelMetrics[]> {
  const pipelineName =
    process.env.LEADS_REPORT_PIPELINE_NAME ?? DEFAULT_PIPELINE_NAME;

  const { data: statusesData, error: statusesError } = await db
    .from('amo_statuses')
    .select('pipeline_id, status_id, status_name, sort')
    .eq('pipeline_name', pipelineName);
  if (statusesError) throw statusesError;

  const statuses = (statusesData ?? []) as AmoStatusMetricRow[];
  const thresholds = buildThresholds(statuses);
  const startIso = start.toISOString();
  const endIso = end.toISOString();

  const { data: leadsData, error: leadsError } = await db
    .from('amo_leads')
    .select('amo_id, pipeline_id, status_id, name, created_at, raw')
    .eq('pipeline_id', thresholds.pipelineId)
    .gte('created_at', startIso)
    .lt('created_at', endIso);
  if (leadsError) throw leadsError;

  const leads = (leadsData ?? []) as AmoLeadMetricRow[];

  // История переходов нужна, чтобы считать метрики по максимально достигнутому
  // этапу, а не по текущему этапу карточки. Тянем чанками по `IN_CHUNK_SIZE` —
  // тот же приём, что в `firstSales/meetings.ts`: у PostgREST есть предел длины
  // URL. Сделок в окне порядка семидесяти, так что чанк обычно один.
  //
  // Фильтра `changed_at < end` здесь намеренно НЕТ, и это не забытая
  // оптимизация. Окно по времени режет `computePeak`, и только он: этап
  // создания сделки он берёт из `from_value` самого раннего перехода, а тот
  // может лежать как угодно поздно. У заявки вечера пятницы, которую разобрали
  // в понедельник, ВСЯ история позже конца окна — с фильтром запрос вернул бы
  // ноль строк, `computePeak` откатился бы на `lead.status_id`, то есть на
  // сегодняшний этап, и понедельничная встреча задним числом попала бы в
  // пятничный отчёт. Ровно то, от чего защищает `changedAt >= end` в
  // `computePeak`. Строк на сделку единицы, экономить тут нечего.
  const dealIds = [...new Set(leads.map((lead) => lead.amo_id))];
  const eventChunks = await Promise.all(
    chunkArray(dealIds, IN_CHUNK_SIZE).map(async (chunk) => {
      const { data, error } = await db
        .from('amo_events')
        .select('amo_deal_id, changed_at, from_value, to_value')
        .eq('event_type', 'lead_status_changed')
        .in('amo_deal_id', chunk);
      if (error) throw error;
      return (data ?? []) as AmoStatusEventRow[];
    }),
  );

  const statusEvents = eventChunks.flat();
  warnOnUnknownStatuses(statusEvents, thresholds);

  return computeMetricsFromRows(
    channels,
    statuses,
    leads,
    statusEvents,
    start,
    end,
  );
}

/**
 * Ругается в лог на переходы в этапы, которых нет в `amo_statuses`.
 *
 * `computePeak` оценивает такой этап в 0 (см. `sortOf`), то есть сделка, чей
 * максимум пришёлся на него, молча выпадает из «Лидов» и обеих метрик встреч.
 * В боевых данных такие есть: 16 событий указывают на 63384134 и 63432998 —
 * этапы, удалённые из AMO. Сейчас безвредно (все старше 25.06, и у каждой из
 * тех сделок был другой путь), но «молча неверная цифра» — ровно то, что этот
 * отчёт уже дважды заставляло расследовать вручную.
 *
 * Здесь `warn`, а не `throw`, в отличие от `buildThresholds`. Разница в том,
 * чего именно не хватает: `buildThresholds` падает на пропаже ОПОРНОГО этапа
 * («Квалифицированный лид», «Назначена встреча», «Встреча проведена»,
 * «Перенос») — без него порогов нет и считать нечего, любая цифра будет
 * выдумкой. А удалить рядовой этап из воронки — законная операция продаж, и
 * ронять из-за неё пятничный отчёт нельзя: отчёт с одной сомнительной сделкой
 * полезнее, чем неотправленный отчёт.
 */
function warnOnUnknownStatuses(
  statusEvents: AmoStatusEventRow[],
  thresholds: Thresholds,
): void {
  const unknownStatusIds = new Set<number>();
  const affectedDeals = new Set<number>();

  for (const event of statusEvents) {
    const statusId = toStatusId(event.to_value);
    if (statusId === null || thresholds.sortByStatusId.has(statusId)) continue;
    unknownStatusIds.add(statusId);
    affectedDeals.add(event.amo_deal_id);
  }

  if (unknownStatusIds.size === 0) return;

  console.warn(
    '[leads-report] переходы в этапы, которых нет в amo_statuses:'
    + ` ${[...unknownStatusIds].sort((a, b) => a - b).join(', ')}.`
    + ` Затронуто сделок: ${affectedDeals.size}.`
    + ' Их максимальный этап считается как 0 — метрики по ним занижены.',
  );
}

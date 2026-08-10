/**
 * Метрики дашборда первички.
 *
 * Отличия от `salesReport/metrics.ts` — сознательные, зафиксированы в спеке:
 *   1. Лиды считаются ВСЕ, включая закрытые в минус и лид-магниты. Отчёт продаж
 *      их выбрасывает; для дашборда это означало бы, что число лидов за май
 *      уменьшается задним числом каждый раз, когда майскую сделку закрывают.
 *      Прошлое должно быть неподвижным.
 *   2. Договоры считаются по ДАТЕ достижения этапа из истории переходов, а
 *      не когортно «из пришедших в окне дошли до». Встречи — по ДАТЕ записи
 *      разговора (`meeting_deal_links` → `tg_video_transcripts`), а не по
 *      этапу AMO вовсе: этап «Встреча проведена» засорён, см. `meetings.ts`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { chunkArray, IN_CHUNK_SIZE } from '@/lib/cisLeads/batchedQuery';
import { bucketKey, buildBuckets, type GroupBy } from '@/lib/firstSales/buckets';
import { MEETINGS_RELIABLE_SINCE, type MeetingLinkRow } from '@/lib/firstSales/meetings';
import {
  buildSourceIndex,
  resolveChannel,
  type FirstSalesChannel,
  type ResolvedChannel,
  type SourceChannelRow,
} from '@/lib/firstSales/sourceChannels';

export type FirstSalesLeadRow = {
  amo_id: number;
  name: string | null;
  created_at: string | null;
  first_qualified_at: string | null;
  first_meeting_at: string | null;
  first_contract_at: string | null;
  won_at: string | null;
  history_complete: boolean;
  raw: unknown;
};

export type SeriesBucket = {
  key: string;
  leads: number;
  qualified: number;
  meetings: number;
  contracts: number;
};

export type SourceBreakdown = {
  source: string;
  channel: FirstSalesChannel;
  known: boolean;
  leads: number;
  qualified: number;
  meetings: number;
  contracts: number;
};

export type FirstSalesTotals = {
  leads: number;
  qualified: number;
  meetings: number;
  contracts: number;
  leadMagnets: number;
  unassignedLeads: number;
  wonCount: number;
  cycleAvgDays: number | null;
  cycleMedianDays: number | null;
  /**
   * false — окно целиком раньше даты, с которой этап «Согласование договора»
   * начал означать договор. Тогда `contracts` заведомо равен нулю не потому,
   * что договоров не было, а потому что мы отказались считать грязные данные.
   * UI обязан показать прочерк, а не ноль.
   */
  contractsReliable: boolean;
  /** Дата вступления правила в силу — чтобы UI мог назвать её пользователю. */
  contractsSince: string;
  /**
   * false — окно целиком раньше даты, с которой подписи к записям в чате
   * встреч стали регулярными (`MEETINGS_RELIABLE_SINCE`). Тогда `meetings`
   * заведомо занижен не потому, что встреч не было, а потому что автоматчер
   * не может привязать запись без подписи. UI обязан показать прочерк.
   */
  meetingsReliable: boolean;
  /** Дата вступления правила в силу — чтобы UI мог назвать её пользователю. */
  meetingsSince: string;
};

export type FirstSalesSeries = {
  series: SeriesBucket[];
  bySource: SourceBreakdown[];
  totals: FirstSalesTotals;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Лид-магнит — сделка, автосозданная TG-ботом «Polza Site Feedback»:
 *  имя всегда с префиксом «Бот:». Из лидов не исключается, но считается
 *  отдельно, чтобы всплеск магнитов не читался как рост спроса. */
function isLeadMagnet(name: string | null): boolean {
  return typeof name === 'string' && name.trimStart().startsWith('Бот:');
}

function inWindow(value: string | null, from: Date, to: Date): boolean {
  if (!value) return false;
  const t = new Date(value).getTime();
  return Number.isFinite(t) && t >= from.getTime() && t <= to.getTime();
}

/**
 * Дата, с которой этап «Согласование договора» в AMO начал означать договор.
 *
 * До неё этап ставили и когда договор действительно правили, и когда его
 * просто отправили по просьбе клиента. Из-за этого за июнь 2026 туда попали
 * 169 сделок, из которых 162 умерли с нулевой суммой, — при том что реальных
 * договоров у продаж около двадцати в месяц. Разделить одно от другого задним
 * числом нечем: в данных нет признака, по которому это можно отличить.
 *
 * Егор с командой договорились (30.07.2026) ставить этап только при реальном
 * согласовании и правках. Поэтому договоры считаются с этой даты, а раньше
 * отдаётся `null` — прочерк, а не ноль: ноль читался бы как «договоров не
 * было», и это было бы враньём худшего сорта, чем отсутствие цифры.
 */
export const CONTRACT_RULE_SINCE = new Date(
  process.env.FIRST_SALES_CONTRACT_RULE_SINCE ?? '2026-07-30T00:00:00.000Z',
);

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function computeFirstSalesSeries(
  leads: FirstSalesLeadRow[],
  meetingLinks: MeetingLinkRow[],
  sourceMap: SourceChannelRow[],
  from: Date,
  to: Date,
  groupBy: GroupBy,
  channelFilter: FirstSalesChannel[] | null,
): FirstSalesSeries {
  const index = buildSourceIndex(sourceMap);
  const allowed = channelFilter && channelFilter.length > 0 ? new Set(channelFilter) : null;

  const keys = buildBuckets(from, to, groupBy);
  const series = new Map<string, SeriesBucket>(
    keys.map((key) => [key, { key, leads: 0, qualified: 0, meetings: 0, contracts: 0 }]),
  );
  const bySource = new Map<string, SourceBreakdown>();

  const totals: FirstSalesTotals = {
    leads: 0, qualified: 0, meetings: 0, contracts: 0,
    leadMagnets: 0, unassignedLeads: 0, wonCount: 0,
    cycleAvgDays: null, cycleMedianDays: null,
    contractsReliable: to.getTime() >= CONTRACT_RULE_SINCE.getTime(),
    contractsSince: CONTRACT_RULE_SINCE.toISOString(),
    meetingsReliable: to.getTime() >= MEETINGS_RELIABLE_SINCE.getTime(),
    meetingsSince: MEETINGS_RELIABLE_SINCE.toISOString(),
  };
  const cycles: number[] = [];

  // Канал встречи берётся у СДЕЛКИ, не у записи разговора — иначе фильтр по
  // каналам не работал бы для встреч. Карта заполняется ниже, в основном
  // цикле по `leads`, ДО фильтра по каналу (см. комментарий у `continue`),
  // чтобы в ней остались все сделки независимо от того, какой канал сейчас
  // выбран в фильтре — фильтрация встреч по каналу применяется отдельно,
  // при их собственной обработке.
  const dealChannelMap = new Map<number, ResolvedChannel>();

  // Тип поля сужен до счётчиков: `keyof SeriesBucket` включал бы `key: string`,
  // и `bucket[field] += 1` не прошёл бы проверку типов.
  type CounterField = 'leads' | 'qualified' | 'meetings' | 'contracts';
  const bump = (key: string | null, field: CounterField) => {
    if (!key) return;
    const bucket = series.get(key);
    if (bucket) bucket[field] += 1;
  };

  for (const lead of leads) {
    const resolved = resolveChannel(lead.raw, index);
    dealChannelMap.set(lead.amo_id, resolved);
    if (allowed && !allowed.has(resolved.channel)) continue;

    const sourceKey = resolved.source || '(не указан)';
    let breakdown = bySource.get(sourceKey);
    if (!breakdown) {
      breakdown = {
        source: sourceKey,
        channel: resolved.channel,
        known: resolved.known,
        leads: 0, qualified: 0, meetings: 0, contracts: 0,
      };
      bySource.set(sourceKey, breakdown);
    }
    // Примечание (само-ревью): channel/known в строке разбивки фиксируются по
    // ПЕРВОЙ встреченной сделке с этим sourceKey. Для непустого «Источник» это
    // безопасно — resolveChannel детерминирована по нормализованному значению
    // источника. Единственное исключение — пустой источник (sourceKey
    // «(не указан)»): resolveChannel в этом случае смотрит ещё и на «Контур»,
    // и разные сделки без «Источник» могут получить разный channel (marketing
    // при «Контур=Маркетинг» vs unassigned без него). В totals это не течёт —
    // там каждая сделка бампится в свой резолвнутый канал корректно, — но
    // строка «(не указан)» в bySource может показать канал только первой
    // попавшейся сделки. Не критично (totals точны), но известное упрощение.

    // Лиды — по дате создания. Без исключений по статусу.
    if (inWindow(lead.created_at, from, to)) {
      totals.leads += 1;
      breakdown.leads += 1;
      bump(bucketKey(new Date(lead.created_at as string), groupBy), 'leads');
      if (isLeadMagnet(lead.name)) totals.leadMagnets += 1;
      if (resolved.channel === 'unassigned') totals.unassignedLeads += 1;

      // «Дошёл до квала» кладётся в корзину по дате СОЗДАНИЯ, а не по дате
      // достижения этапа (first_qualified_at используется только как флаг
      // «дошёл ли»). Это когортная семантика — «из пришедших в этот день/
      // неделю/месяц скольких сумели квалифицировать», та же логика, что и у
      // «леды». Отличается от meetings/contracts ниже, которые по спеке
      // кладутся по дате самого этапа («сколько встреч случилось в этот
      // день», независимо от того, когда лид пришёл). Оба взгляда осмыслены,
      // но соседствуют в одном SeriesBucket — при чтении графика это стоит
      // держать в голове: столбец qualified отвечает на другой вопрос, чем
      // столбцы meetings/contracts в той же строке.
      if (lead.first_qualified_at && lead.history_complete) {
        totals.qualified += 1;
        breakdown.qualified += 1;
        bump(bucketKey(new Date(lead.created_at as string), groupBy), 'qualified');
      }
    }

    // Договор — по дате достижения этапа. Сделка с неполной историей
    // исключается: у неё переход мог случиться до горизонта событий, и мы его
    // не видели. Считать её нулём — врать.
    //
    // Встречи здесь больше не считаются: этап AMO «Встреча проведена» был
    // источником этой метрики раньше и давал 200+ встреч в месяц против 64 у
    // руководителя продаж — этап засорён, сделку двигают по нему и без
    // реальной встречи. Новый расчёт — ниже, отдельным проходом по
    // `meetingLinks` (привязки записей разговоров к сделкам), см. блок после
    // основного цикла. `first_meeting_at` на объекте лида НЕ удалён — он
    // остаётся полезным следом того, что происходило в CRM, и показывается в
    // drill-down (SourceTable) под меткой «Этап AMO», но в счётчик встреч не
    // идёт, чтобы под одним названием не жили две разные цифры.
    if (lead.history_complete) {
      // Договоры — только с даты, когда этап начал означать договор.
      // До неё этап ставили и на «просто отправил файл», см. CONTRACT_RULE_SINCE.
      if (
        inWindow(lead.first_contract_at, from, to)
        && new Date(lead.first_contract_at as string).getTime() >= CONTRACT_RULE_SINCE.getTime()
      ) {
        totals.contracts += 1;
        breakdown.contracts += 1;
        bump(bucketKey(new Date(lead.first_contract_at as string), groupBy), 'contracts');
      }
    }

    // Цикл — от создания до оплаты, по оплаченным в окне. От глубины истории
    // событий не зависит: won_at приходит из closed_at.
    if (inWindow(lead.won_at, from, to) && lead.created_at) {
      const days =
        (new Date(lead.won_at as string).getTime() - new Date(lead.created_at).getTime()) / DAY_MS;
      if (Number.isFinite(days) && days >= 0) {
        totals.wonCount += 1;
        cycles.push(days);
      }
    }
  }

  if (cycles.length > 0) {
    totals.cycleAvgDays = cycles.reduce((a, b) => a + b, 0) / cycles.length;
    totals.cycleMedianDays = median(cycles);
  }

  // ─── Встречи — по привязкам записей разговоров ──────────────────────────
  //
  // Встреча = уникальная пара (сделка, дата записи по МСК), а не запись.
  // Одна встреча часто разрезана на несколько файлов: в боевых данных
  // `denvic.tech` встречается дважды за один день файлами `1.mp4` и `2.mp4` —
  // это одна встреча, а не две. Дедуп — по дню в МСК (bucketKey с groupBy
  // 'day' независимо от groupBy самого графика): при groupBy='month' два
  // разных июльских дня одной сделки — всё ещё две встречи, просто обе
  // попадают в одну месячную корзину графика.
  const meetingDayKeys = new Set<string>();
  for (const link of meetingLinks) {
    const meetingDate = new Date(link.meeting_at);
    if (!Number.isFinite(meetingDate.getTime())) continue;
    if (!inWindow(link.meeting_at, from, to)) continue;
    // Подписи к записям стали регулярными только с MEETINGS_RELIABLE_SINCE —
    // раньше запись без подписи автоматчер привязать не мог, и привязок за
    // март/апрель кратно меньше июньских/июльских. Считать эти месяцы нулём
    // было бы неверно (см. totals.meetingsReliable), но досчитать их тоже
    // нечем — единственное честное действие для отдельных ранних записей,
    // которые всё же как-то привязались, — не звать их системным сигналом.
    // Не отбрасывать раннюю запись означало бы дать частичную, непроверяемую
    // цифру за месяц, который дальше в UI помечен прочерком.
    if (meetingDate.getTime() < MEETINGS_RELIABLE_SINCE.getTime()) continue;

    const dayKey = `${link.amo_deal_id}|${bucketKey(meetingDate, 'day')}`;
    if (meetingDayKeys.has(dayKey)) continue; // тот же день, та же сделка — один файл из нескольких
    meetingDayKeys.add(dayKey);

    // Сделка, на которую сослалась привязка, но которой нет в `leads`, —
    // защитный случай (см. `fetchFirstSalesLeads`, параметр `extraDealIds`:
    // в проде такая сделка должна была подтянуться именно через него). Если
    // всё же не подтянулась — не роняем расчёт, относим встречу к «не
    // распределено» вместо того, чтобы потерять её вовсе.
    const resolved = dealChannelMap.get(link.amo_deal_id);
    const channel = resolved?.channel ?? 'unassigned';
    if (allowed && !allowed.has(channel)) continue;

    totals.meetings += 1;
    bump(bucketKey(meetingDate, groupBy), 'meetings');

    const sourceKey = resolved?.source || '(не указан)';
    let breakdown = bySource.get(sourceKey);
    if (!breakdown) {
      breakdown = {
        source: sourceKey,
        channel,
        known: resolved?.known ?? false,
        leads: 0, qualified: 0, meetings: 0, contracts: 0,
      };
      bySource.set(sourceKey, breakdown);
    }
    breakdown.meetings += 1;
  }

  return {
    series: keys.map((k) => series.get(k) as SeriesBucket),
    // Пустые строки отбрасываем: выборка тянет сделки с любой активностью в
    // окне, поэтому источник может попасть в разбивку из-за оплаты старой
    // сделки и дать строку из одних нулей. Строка «источник, по которому
    // ничего не произошло» — шум, а не факт. `known`/`channel` при этом не
    // теряются: фильтр только отбрасывает строки целиком по сумме счётчиков,
    // остальные поля объекта не трогает.
    bySource: [...bySource.values()]
      .filter((s) => s.leads + s.qualified + s.meetings + s.contracts > 0)
      .sort((a, b) => b.leads - a.leads),
    totals,
  };
}

const STAGE_DATE_COLUMNS =
  'amo_deal_id, created_at, first_qualified_at, first_meeting_at, first_contract_at, won_at, history_complete';

type StageDateRow = Omit<FirstSalesLeadRow, 'amo_id' | 'name' | 'raw'> & { amo_deal_id: number };

/**
 * Тянет сделки воронки первички вместе с датами этапов из view.
 *
 * `extraDealIds` — сделки, которые обязаны попасть в выборку ДАЖЕ если ни
 * одно из полей окна (`created_at`/`first_meeting_at`/`first_contract_at`/
 * `won_at`) в окно не попадает. Нужны для встреч: сделка могла прийти в
 * марте, а привязанная запись разговора — датироваться июлем; фильтр по
 * стадиям её не увидит, а `computeFirstSalesSeries` без неё не сможет
 * определить канал сделки для встречи (канал резолвится из `raw`, который
 * есть только у сделок, попавших в этот массив) — встреча в лучшем случае
 * ушла бы в «не распределено», в худшем — потерялась бы при фильтре по
 * каналу. Вызывающий код передаёт сюда id сделок из `fetchMeetingLinks` за
 * то же окно.
 */
export async function fetchFirstSalesLeads(
  db: SupabaseClient,
  pipelineId: number,
  from: Date,
  to: Date,
  extraDealIds: number[] = [],
): Promise<FirstSalesLeadRow[]> {
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  // Берём сделки с ЛЮБОЙ активностью в окне: созданы, дошли до встречи,
  // до договора или оплачены. Иначе встреча июльской сделки, пришедшей в июне,
  // в июльское окно не попадёт.
  const { data, error } = await db
    .from('amo_lead_stage_dates_v')
    .select(STAGE_DATE_COLUMNS)
    .eq('pipeline_id', pipelineId)
    .or(
      `and(created_at.gte.${fromIso},created_at.lte.${toIso}),` +
        `and(first_meeting_at.gte.${fromIso},first_meeting_at.lte.${toIso}),` +
        `and(first_contract_at.gte.${fromIso},first_contract_at.lte.${toIso}),` +
        `and(won_at.gte.${fromIso},won_at.lte.${toIso})`,
    );
  if (error) throw error;

  const stageRows = (data ?? []) as StageDateRow[];

  // Сделки из extraDealIds, которые окно по стадиям не поймало (см. doc-
  // комментарий выше). Отдельным запросом, без date-фильтра — только
  // воронка и конкретные id.
  const seenIds = new Set(stageRows.map((r) => r.amo_deal_id));
  const missingExtraIds = extraDealIds.filter((id) => !seenIds.has(id));
  const extraChunks = await Promise.all(
    chunkArray(missingExtraIds, IN_CHUNK_SIZE).map(async (chunk) => {
      const { data: extraData, error: extraError } = await db
        .from('amo_lead_stage_dates_v')
        .select(STAGE_DATE_COLUMNS)
        .eq('pipeline_id', pipelineId)
        .in('amo_deal_id', chunk);
      if (extraError) throw extraError;
      return (extraData ?? []) as StageDateRow[];
    }),
  );
  // Дедуп после сбора, а не по ходу цикла: чанки теперь идут параллельно, и
  // «уже видели» нельзя проверять внутри чанка — только когда пришли все.
  // Чанки не пересекаются по id, но `seenIds` сюда приходит уже непустым
  // (сделки из оконной выборки), так что проверка нужна.
  for (const row of extraChunks.flat()) {
    if (seenIds.has(row.amo_deal_id)) continue;
    stageRows.push(row);
    seenIds.add(row.amo_deal_id);
  }

  if (stageRows.length === 0) return [];

  // Список id может уйти за тысячи сделок (год активности воронки). PostgREST
  // отдаёт весь `.in(...)` одной строкой query-параметра — при большом списке
  // это НЕ тихо усекает выборку, а роняет запрос целиком (400/414: URL
  // превышает ~8 КБ). В этом кодовом стиле уже есть готовый паттерн под эту
  // проблему — `cisLeads/batchedQuery.ts` — используем его: бьём id на чанки
  // по IN_CHUNK_SIZE и мержим результаты.
  const ids = stageRows.map((r) => r.amo_deal_id);
  const leadChunks = await Promise.all(
    chunkArray(ids, IN_CHUNK_SIZE).map(async (chunk) => {
      const { data: leadsChunk, error: leadsError } = await db
        .from('amo_leads')
        .select('amo_id, name, raw')
        .in('amo_id', chunk);
      if (leadsError) throw leadsError;
      return (leadsChunk ?? []) as Array<{ amo_id: number; name: string | null; raw: unknown }>;
    }),
  );
  const leadsById = new Map<number, { name: string | null; raw: unknown }>();
  for (const l of leadChunks.flat()) {
    leadsById.set(l.amo_id, { name: l.name, raw: l.raw });
  }

  return stageRows.map((r) => ({
    amo_id: r.amo_deal_id,
    name: leadsById.get(r.amo_deal_id)?.name ?? null,
    raw: leadsById.get(r.amo_deal_id)?.raw ?? null,
    created_at: r.created_at,
    first_qualified_at: r.first_qualified_at,
    first_meeting_at: r.first_meeting_at,
    first_contract_at: r.first_contract_at,
    won_at: r.won_at,
    history_complete: r.history_complete,
  }));
}

export async function fetchSourceMap(db: SupabaseClient): Promise<SourceChannelRow[]> {
  const { data, error } = await db
    .from('lead_source_channels')
    .select('source, channel, display_name')
    .order('sort_order');
  if (error) throw error;
  return (data ?? []) as SourceChannelRow[];
}

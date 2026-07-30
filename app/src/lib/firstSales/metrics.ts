/**
 * Метрики дашборда первички.
 *
 * Отличия от `salesReport/metrics.ts` — сознательные, зафиксированы в спеке:
 *   1. Лиды считаются ВСЕ, включая закрытые в минус и лид-магниты. Отчёт продаж
 *      их выбрасывает; для дашборда это означало бы, что число лидов за май
 *      уменьшается задним числом каждый раз, когда майскую сделку закрывают.
 *      Прошлое должно быть неподвижным.
 *   2. Встречи и договоры считаются по ДАТЕ достижения этапа из истории
 *      переходов, а не когортно «из пришедших в окне дошли до».
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { chunkArray, IN_CHUNK_SIZE } from '@/lib/cisLeads/batchedQuery';
import { bucketKey, buildBuckets, type GroupBy } from '@/lib/firstSales/buckets';
import {
  buildSourceIndex,
  resolveChannel,
  type FirstSalesChannel,
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
  };
  const cycles: number[] = [];

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

    // Встречи и договоры — по дате достижения этапа. Сделка с неполной историей
    // исключается: у неё переход мог случиться до горизонта событий, и мы его
    // не видели. Считать её нулём — врать.
    if (lead.history_complete) {
      if (inWindow(lead.first_meeting_at, from, to)) {
        totals.meetings += 1;
        breakdown.meetings += 1;
        bump(bucketKey(new Date(lead.first_meeting_at as string), groupBy), 'meetings');
      }
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

/** Тянет сделки воронки первички вместе с датами этапов из view. */
export async function fetchFirstSalesLeads(
  db: SupabaseClient,
  pipelineId: number,
  from: Date,
  to: Date,
): Promise<FirstSalesLeadRow[]> {
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  // Берём сделки с ЛЮБОЙ активностью в окне: созданы, дошли до встречи,
  // до договора или оплачены. Иначе встреча июльской сделки, пришедшей в июне,
  // в июльское окно не попадёт.
  const { data, error } = await db
    .from('amo_lead_stage_dates_v')
    .select(
      'amo_deal_id, created_at, first_qualified_at, first_meeting_at, first_contract_at, won_at, history_complete',
    )
    .eq('pipeline_id', pipelineId)
    .or(
      `and(created_at.gte.${fromIso},created_at.lte.${toIso}),` +
        `and(first_meeting_at.gte.${fromIso},first_meeting_at.lte.${toIso}),` +
        `and(first_contract_at.gte.${fromIso},first_contract_at.lte.${toIso}),` +
        `and(won_at.gte.${fromIso},won_at.lte.${toIso})`,
    );
  if (error) throw error;

  const stageRows = (data ?? []) as Array<
    Omit<FirstSalesLeadRow, 'amo_id' | 'name' | 'raw'> & { amo_deal_id: number }
  >;
  if (stageRows.length === 0) return [];

  // Список id может уйти за тысячи сделок (год активности воронки). PostgREST
  // отдаёт весь `.in(...)` одной строкой query-параметра — при большом списке
  // это НЕ тихо усекает выборку, а роняет запрос целиком (400/414: URL
  // превышает ~8 КБ). В этом кодовом стиле уже есть готовый паттерн под эту
  // проблему — `cisLeads/batchedQuery.ts` — используем его: бьём id на чанки
  // по IN_CHUNK_SIZE и мержим результаты.
  const ids = stageRows.map((r) => r.amo_deal_id);
  const leadsById = new Map<number, { name: string | null; raw: unknown }>();
  for (const chunk of chunkArray(ids, IN_CHUNK_SIZE)) {
    const { data: leadsChunk, error: leadsError } = await db
      .from('amo_leads')
      .select('amo_id, name, raw')
      .in('amo_id', chunk);
    if (leadsError) throw leadsError;
    for (const l of (leadsChunk ?? []) as Array<{
      amo_id: number;
      name: string | null;
      raw: unknown;
    }>) {
      leadsById.set(l.amo_id, { name: l.name, raw: l.raw });
    }
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

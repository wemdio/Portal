import {
  computeFirstSalesSeries,
  type FirstSalesLeadRow,
} from '@/lib/firstSales/metrics';
import type { SourceChannelRow } from '@/lib/firstSales/sourceChannels';

const map: SourceChannelRow[] = [
  { source: 'email outreach', channel: 'outreach', display_name: 'Email Outreach' },
  { source: 'сайт', channel: 'inbound', display_name: 'Сайт' },
];

function lead(over: Partial<FirstSalesLeadRow> = {}): FirstSalesLeadRow {
  return {
    amo_id: 1,
    name: 'Обычная сделка',
    created_at: '2026-07-15T09:00:00.000Z',
    first_qualified_at: null,
    first_meeting_at: null,
    first_contract_at: null,
    won_at: null,
    history_complete: true,
    raw: {
      custom_fields_values: [
        { field_name: 'Источник', values: [{ value: 'Email Outreach' }] },
      ],
    },
    ...over,
  };
}

const from = new Date('2026-07-01T00:00:00.000Z');
// Конец июля по МСК, не по UTC: buildBuckets режет дни в МСК (см.
// firstSales/buckets.ts), и 2026-07-31T23:59:59.999Z — это уже
// 2026-08-01 02:59:59 МСК, то есть корзина 1 августа. 20:59:59.999Z —
// последний момент 31 июля именно в МСК.
const to = new Date('2026-07-31T20:59:59.999Z');

describe('computeFirstSalesSeries', () => {
  it('считает лидов по дате создания', () => {
    const res = computeFirstSalesSeries(
      [lead({ amo_id: 1 }), lead({ amo_id: 2, created_at: '2026-07-16T09:00:00.000Z' })],
      map, from, to, 'day', null,
    );
    expect(res.totals.leads).toBe(2);
    expect(res.series.find((b) => b.key === '2026-07-15')?.leads).toBe(1);
    expect(res.series.find((b) => b.key === '2026-07-16')?.leads).toBe(1);
  });

  it('мёртвые сделки и лид-магниты остаются в лидах', () => {
    // Отчёт продаж их выбрасывает; дашборд — нет, иначе прошлое едет.
    const res = computeFirstSalesSeries(
      [lead({ amo_id: 1, name: 'Бот: Иван' })],
      map, from, to, 'day', null,
    );
    expect(res.totals.leads).toBe(1);
    expect(res.totals.leadMagnets).toBe(1);
  });

  it('встречи считаются по дате достижения этапа, а не по дате создания', () => {
    const res = computeFirstSalesSeries(
      [lead({
        created_at: '2026-06-20T09:00:00.000Z',      // лид пришёл в июне
        first_meeting_at: '2026-07-10T09:00:00.000Z', // встреча в июле
      })],
      map, from, to, 'day', null,
    );
    expect(res.totals.leads).toBe(0);
    expect(res.totals.meetings).toBe(1);
    expect(res.series.find((b) => b.key === '2026-07-10')?.meetings).toBe(1);
  });

  it('сделка с неполной историей не даёт встреч и договоров, но остаётся лидом', () => {
    const res = computeFirstSalesSeries(
      [lead({
        history_complete: false,
        first_meeting_at: '2026-07-10T09:00:00.000Z',
        first_contract_at: '2026-07-12T09:00:00.000Z',
      })],
      map, from, to, 'day', null,
    );
    expect(res.totals.leads).toBe(1);
    expect(res.totals.meetings).toBe(0);
    expect(res.totals.contracts).toBe(0);
  });

  it('фильтр по каналам применяется ко всем метрикам', () => {
    const res = computeFirstSalesSeries(
      [
        lead({ amo_id: 1 }),                                            // outreach
        lead({
          amo_id: 2,
          raw: { custom_fields_values: [{ field_name: 'Источник', values: [{ value: 'Сайт' }] }] },
        }),                                                             // inbound
      ],
      map, from, to, 'day', ['outreach'],
    );
    expect(res.totals.leads).toBe(1);
  });

  it('средний цикл и медиана считаются по оплаченным в периоде', () => {
    const res = computeFirstSalesSeries(
      [
        lead({ amo_id: 1, created_at: '2026-07-01T00:00:00.000Z', won_at: '2026-07-11T00:00:00.000Z' }), // 10 дней
        lead({ amo_id: 2, created_at: '2026-07-01T00:00:00.000Z', won_at: '2026-07-21T00:00:00.000Z' }), // 20 дней
        lead({ amo_id: 3, created_at: '2026-01-01T00:00:00.000Z', won_at: '2026-07-31T00:00:00.000Z' }), // 211 дней
      ],
      map, from, to, 'day', null,
    );
    expect(res.totals.wonCount).toBe(3);
    expect(res.totals.cycleMedianDays).toBe(20);
    expect(Math.round(res.totals.cycleAvgDays ?? 0)).toBe(80);
  });

  it('пустая выборка не даёт NaN', () => {
    const res = computeFirstSalesSeries([], map, from, to, 'day', null);
    expect(res.totals.leads).toBe(0);
    expect(res.totals.cycleAvgDays).toBeNull();
    expect(res.totals.cycleMedianDays).toBeNull();
  });

  it('пустые корзины присутствуют в ряду', () => {
    const res = computeFirstSalesSeries([lead()], map, from, to, 'day', null);
    expect(res.series).toHaveLength(31);
    expect(res.series[0]).toEqual(
      expect.objectContaining({ key: '2026-07-01', leads: 0, meetings: 0 }),
    );
  });

  it('считает разбивку по источникам с пометкой неизвестных', () => {
    const res = computeFirstSalesSeries(
      [
        lead({ amo_id: 1 }),
        lead({
          amo_id: 2,
          raw: { custom_fields_values: [{ field_name: 'Источник', values: [{ value: 'Нейровыдача' }] }] },
        }),
      ],
      map, from, to, 'day', null,
    );
    const unknown = res.bySource.find((s) => s.source === 'нейровыдача');
    expect(unknown?.leads).toBe(1);
    expect(unknown?.known).toBe(false);
    expect(res.totals.unassignedLeads).toBe(1);
  });
});

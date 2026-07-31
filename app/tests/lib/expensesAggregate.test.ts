/** @jest-environment node */

import { summarize, breakdownByVendor } from '@/lib/expenses/aggregate';
import type { ExpenseRow } from '@/lib/expenses/types';

function row(over: Partial<ExpenseRow>): ExpenseRow {
  return {
    source: 'tochka',
    source_ref: 'r1',
    occurred_on_msk: '2026-07-15',
    amount: 100,
    currency: 'RUB',
    counterparty: 'ООО Ромашка',
    counterparty_inn: null,
    details: null,
    vendor_id: 'v1',
    vendor_name: 'OpenAI',
    category: 'tools',
    classification_method: 'rule',
    amount_rub: 100,
    ...over,
  };
}

describe('summarize', () => {
  it('перемещения не попадают в итог, но считаются отдельно', () => {
    const s = summarize(
      [
        row({ source_ref: 'a', amount_rub: 100 }),
        row({ source_ref: 'b', amount_rub: 900, category: 'transfer', vendor_name: 'Пополнение Brocard' }),
      ],
      'day',
      { from: '2026-07-15', to: '2026-07-15' },
      null,
    );
    expect(s.total).toBe(100);
    expect(s.transfersTotal).toBe(900);
  });

  it('перемещения не попадают и в ряд по времени', () => {
    const s = summarize(
      [
        row({ source_ref: 'a', amount_rub: 100 }),
        row({ source_ref: 'b', amount_rub: 900, category: 'transfer' }),
      ],
      'day',
      { from: '2026-07-15', to: '2026-07-15' },
      null,
    );
    expect(s.series).toEqual([
      { bucket: '2026-07-15', total: 100, byCategory: { tools: 100 }, bySource: { tochka: 100 }, partial: false },
    ]);
  });

  it('неразмеченное входит в итог и отдельно подсвечивается', () => {
    const s = summarize(
      [row({ amount_rub: 250, vendor_id: null, vendor_name: null, category: null, classification_method: null })],
      'day',
      { from: '2026-07-15', to: '2026-07-15' },
      null,
    );
    expect(s.total).toBe(250);
    expect(s.unclassifiedCount).toBe(1);
    expect(s.unclassifiedTotal).toBe(250);
  });

  it('строка без курса считается отдельно и не ломает итог', () => {
    const s = summarize(
      [
        row({ source_ref: 'a', amount_rub: 100 }),
        row({ source_ref: 'b', currency: 'USD', amount: 10, amount_rub: null }),
      ],
      'day',
      { from: '2026-07-15', to: '2026-07-15' },
      null,
    );
    expect(s.total).toBe(100);
    expect(s.unconvertedCount).toBe(1);
    expect(s.unconvertedByCurrency).toEqual({ USD: 10 });
  });

  it('среднее в день делится на длину периода, а не на число операций', () => {
    const s = summarize(
      [row({ amount_rub: 310 })],
      'day',
      { from: '2026-07-01', to: '2026-07-31' },
      null,
    );
    expect(s.avgPerDay).toBe(10);
  });

  it('дельта к прошлому периоду в долях', () => {
    const s = summarize(
      [row({ amount_rub: 150 })],
      'day',
      { from: '2026-07-15', to: '2026-07-15' },
      [row({ source_ref: 'p', amount_rub: 100 })],
    );
    expect(s.deltaPrev).toBeCloseTo(0.5);
  });

  it('дельта не считается, если в прошлом периоде нечего сравнивать', () => {
    const s = summarize([row({ amount_rub: 150 })], 'day', { from: '2026-07-15', to: '2026-07-15' }, []);
    expect(s.deltaPrev).toBeNull();
  });

  it('пустой список строк не ломает агрегацию', () => {
    const s = summarize([], 'day', { from: '2026-07-01', to: '2026-07-01' }, []);
    expect(s.total).toBe(0);
    expect(s.series).toEqual([]);
    expect(s.unconvertedByCurrency).toEqual({});
    expect(s.deltaPrev).toBeNull();
  });

  it('дробные суммы из brocard не округляются', () => {
    // numeric(14,2) * numeric(18,6) в базе — круглых чисел не бывает.
    const s = summarize(
      [row({ source: 'brocard', currency: 'USD', amount: 5432.1, amount_rub: 408123.4567 })],
      'day',
      { from: '2026-07-15', to: '2026-07-15' },
      null,
    );
    expect(s.total).toBe(408123.4567);
    expect(s.series[0].bySource).toEqual({ brocard: 408123.4567 });
  });

  it('накапливает bySource из разных источников в одном бакете', () => {
    const s = summarize(
      [
        row({ source: 'tochka', source_ref: 'a', amount_rub: 100 }),
        row({ source: 'tbank', source_ref: 'b', amount_rub: 50 }),
        row({ source: 'brocard', source_ref: 'c', currency: 'USD', amount: 25, amount_rub: 25 }),
      ],
      'day',
      { from: '2026-07-15', to: '2026-07-15' },
      null,
    );
    expect(s.series[0].bySource).toEqual({ tochka: 100, tbank: 50, brocard: 25 });
  });

  it('ряд по неделям через границу месяца: сортировка, накопление между бакетами и partial', () => {
    // Период — весь июль. Первая неделя (пн 29 июня — вс 5 июля) начинается
    // раньше периода — partial. Последняя (пн 27 июля — вс 2 августа)
    // заканчивается позже периода — тоже partial. Средняя неделя целиком
    // внутри периода — не partial.
    const s = summarize(
      [
        row({ source_ref: 'a', occurred_on_msk: '2026-07-01', amount_rub: 100 }),
        row({ source_ref: 'b', occurred_on_msk: '2026-07-03', amount_rub: 50 }),
        row({ source_ref: 'c', occurred_on_msk: '2026-07-15', amount_rub: 200 }),
        row({ source_ref: 'd', occurred_on_msk: '2026-07-30', amount_rub: 300 }),
      ],
      'week',
      { from: '2026-07-01', to: '2026-07-31' },
      null,
    );

    expect(s.series).toEqual([
      { bucket: '2026-06-29', total: 150, byCategory: { tools: 150 }, bySource: { tochka: 150 }, partial: true },
      { bucket: '2026-07-13', total: 200, byCategory: { tools: 200 }, bySource: { tochka: 200 }, partial: false },
      { bucket: '2026-07-27', total: 300, byCategory: { tools: 300 }, bySource: { tochka: 300 }, partial: true },
    ]);
  });
});

describe('breakdownByVendor', () => {
  it('складывает вендоров, считает долю и дельту', () => {
    const items = breakdownByVendor(
      [
        row({ source_ref: 'a', amount_rub: 300 }),
        row({ source_ref: 'b', amount_rub: 100, vendor_id: 'v2', vendor_name: 'Instantly' }),
      ],
      [row({ source_ref: 'p', amount_rub: 200 })],
    );
    expect(items[0]).toMatchObject({ vendorName: 'OpenAI', total: 300, ops: 1, share: 0.75, deltaPrev: 0.5 });
    expect(items[1]).toMatchObject({ vendorName: 'Instantly', total: 100, deltaPrev: null });
  });

  it('несколько операций одного вендора складываются в total и ops', () => {
    const items = breakdownByVendor(
      [
        row({ source_ref: 'a', amount_rub: 100 }),
        row({ source_ref: 'b', amount_rub: 200 }),
        row({ source_ref: 'c', amount_rub: 300 }),
      ],
      [],
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ vendorName: 'OpenAI', total: 600, ops: 3 });
  });

  it('неразмеченное собирается в одну строку, дельта к прошлому периоду не считается', () => {
    const items = breakdownByVendor(
      [row({ vendor_id: null, vendor_name: null, category: null, amount_rub: 50 })],
      // Прошлый период тоже с большой неразмеченной кучей — если бы дельта
      // считалась как для обычного вендора, тут был бы шумный "-95%".
      [row({ source_ref: 'p', vendor_id: null, vendor_name: null, category: null, amount_rub: 999 })],
    );
    expect(items[0]).toMatchObject({ vendorId: null, vendorName: 'Без вендора', total: 50, deltaPrev: null });
  });

  it('перемещения в разбивку не попадают', () => {
    const items = breakdownByVendor([row({ category: 'transfer', amount_rub: 900 })], []);
    expect(items).toEqual([]);
  });

  it('строка без курса не считается нулём: видна отдельным счётчиком, а не теряется', () => {
    const items = breakdownByVendor(
      [
        row({ source_ref: 'a', amount_rub: 5000 }),
        row({ source_ref: 'b', currency: 'USD', amount: 5000, amount_rub: null }),
      ],
      [],
    );
    expect(items[0]).toMatchObject({
      vendorName: 'OpenAI',
      total: 5000,
      ops: 2,
      unconvertedCount: 1,
      unconvertedByCurrency: { USD: 5000 },
    });
  });

  it('доля 0, если все траты вендора без курса (total=0, а не NaN)', () => {
    const items = breakdownByVendor([row({ currency: 'USD', amount: 100, amount_rub: null })], []);
    expect(items[0]).toMatchObject({ total: 0, share: 0, unconvertedCount: 1 });
  });

  it('вендор, пропавший в текущем периоде, показывается с total=0 и deltaPrev=-1', () => {
    const items = breakdownByVendor(
      [row({ source_ref: 'a', vendor_id: 'v1', vendor_name: 'OpenAI', amount_rub: 100 })],
      [
        row({ source_ref: 'p1', vendor_id: 'v1', vendor_name: 'OpenAI', amount_rub: 100 }),
        row({
          source_ref: 'p2',
          vendor_id: 'v9',
          vendor_name: 'Facebook Ads',
          category: 'marketing',
          amount_rub: 500,
        }),
      ],
    );
    const facebook = items.find((i) => i.vendorId === 'v9');
    expect(facebook).toMatchObject({ vendorName: 'Facebook Ads', total: 0, ops: 0, share: 0, deltaPrev: -1 });
  });
});

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
      { bucket: '2026-07-15', total: 100, byCategory: { tools: 100 }, bySource: { tochka: 100 } },
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

  it('неразмеченное собирается в одну строку', () => {
    const items = breakdownByVendor(
      [row({ vendor_id: null, vendor_name: null, category: null, amount_rub: 50 })],
      [],
    );
    expect(items[0]).toMatchObject({ vendorId: null, vendorName: 'Без категории', total: 50 });
  });

  it('перемещения в разбивку не попадают', () => {
    const items = breakdownByVendor([row({ category: 'transfer', amount_rub: 900 })], []);
    expect(items).toEqual([]);
  });
});

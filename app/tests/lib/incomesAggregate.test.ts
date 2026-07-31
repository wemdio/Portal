/** @jest-environment node */

import { summarizeIncomes, breakdownByPayer } from '@/lib/expenses/aggregate';
import { UNKNOWN_EXCLUDE_REASON_KEY, type IncomeRow } from '@/lib/expenses/types';

function row(over: Partial<IncomeRow>): IncomeRow {
  return {
    source: 'tochka',
    source_ref: 'r1',
    occurred_on_msk: '2026-07-15',
    amount: 100,
    currency: 'RUB',
    counterparty: 'ООО Ромашка',
    counterparty_inn: '7701234567',
    details: 'Оплата по счёту 12',
    is_revenue: true,
    exclude_reason: null,
    amount_rub: 100,
    ...over,
  };
}

/** Не-выручка: классификатор синка проставил false и записал причину. */
function nonRevenue(over: Partial<IncomeRow>): IncomeRow {
  return row({ is_revenue: false, exclude_reason: 'возврат', ...over });
}

describe('summarizeIncomes', () => {
  it('не-выручка не попадает в итог, но считается отдельно и с причинами', () => {
    const s = summarizeIncomes(
      [
        row({ source_ref: 'a', amount_rub: 100 }),
        nonRevenue({ source_ref: 'b', amount_rub: 900, exclude_reason: 'банк-механика/возврат' }),
        nonRevenue({ source_ref: 'c', amount_rub: 50, exclude_reason: 'перевод себе (ИНН владельца)' }),
        nonRevenue({ source_ref: 'd', amount_rub: 30, exclude_reason: 'банк-механика/возврат' }),
      ],
      'day',
      { from: '2026-07-15', to: '2026-07-15' },
      null,
    );
    expect(s.total).toBe(100);
    expect(s.nonRevenueTotal).toBe(980);
    expect(s.nonRevenueCount).toBe(3);
    expect(s.nonRevenueByReason).toEqual({
      'банк-механика/возврат': 930,
      'перевод себе (ИНН владельца)': 50,
    });
  });

  it('не-выручка не попадает и в ряд по времени', () => {
    const s = summarizeIncomes(
      [
        row({ source_ref: 'a', amount_rub: 100 }),
        nonRevenue({ source_ref: 'b', amount_rub: 900 }),
      ],
      'day',
      { from: '2026-07-15', to: '2026-07-15' },
      null,
    );
    expect(s.series).toEqual([
      { bucket: '2026-07-15', total: 100, bySource: { tochka: 100 }, partial: false },
    ]);
  });

  it('не-выручка без причины складывается в отдельный бакет, а не теряется', () => {
    const s = summarizeIncomes(
      [nonRevenue({ amount_rub: 700, exclude_reason: null })],
      'day',
      { from: '2026-07-15', to: '2026-07-15' },
      null,
    );
    expect(s.nonRevenueTotal).toBe(700);
    expect(s.nonRevenueByReason).toEqual({ [UNKNOWN_EXCLUDE_REASON_KEY]: 700 });
  });

  it('нерасклассифицированный приход (is_revenue = null) считается выручкой', () => {
    // Молчаливая потеря дохода хуже лишнего рубля: лишний виден в списке
    // операций, недостающий — ничем.
    const s = summarizeIncomes(
      [row({ is_revenue: null, exclude_reason: null, amount_rub: 400 })],
      'day',
      { from: '2026-07-15', to: '2026-07-15' },
      null,
    );
    expect(s.total).toBe(400);
    expect(s.nonRevenueTotal).toBe(0);
  });

  it('строка без курса считается отдельно и не ломает итог', () => {
    const s = summarizeIncomes(
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
    const s = summarizeIncomes(
      [row({ amount_rub: 310 })],
      'day',
      { from: '2026-07-01', to: '2026-07-31' },
      null,
    );
    expect(s.avgPerDay).toBe(10);
  });

  it('дельта к прошлому периоду в долях и без учёта не-выручки', () => {
    const s = summarizeIncomes(
      [row({ amount_rub: 150 })],
      'day',
      { from: '2026-07-15', to: '2026-07-15' },
      [
        row({ source_ref: 'p', amount_rub: 100 }),
        nonRevenue({ source_ref: 'p2', amount_rub: 900 }),
      ],
    );
    expect(s.deltaPrev).toBeCloseTo(0.5);
  });

  it('пустой список строк не ломает агрегацию', () => {
    const s = summarizeIncomes([], 'day', { from: '2026-07-01', to: '2026-07-01' }, []);
    expect(s.total).toBe(0);
    expect(s.series).toEqual([]);
    expect(s.nonRevenueByReason).toEqual({});
    expect(s.deltaPrev).toBeNull();
  });

  it('накапливает bySource из обоих банков в одном бакете', () => {
    const s = summarizeIncomes(
      [
        row({ source: 'tochka', source_ref: 'a', amount_rub: 100 }),
        row({ source: 'tbank', source_ref: 'b', amount_rub: 50 }),
      ],
      'day',
      { from: '2026-07-15', to: '2026-07-15' },
      null,
    );
    expect(s.series[0].bySource).toEqual({ tochka: 100, tbank: 50 });
  });

  it('ряд по неделям через границу месяца: сортировка и partial', () => {
    const s = summarizeIncomes(
      [
        row({ source_ref: 'a', occurred_on_msk: '2026-07-01', amount_rub: 100 }),
        row({ source_ref: 'b', occurred_on_msk: '2026-07-15', amount_rub: 200 }),
        row({ source_ref: 'c', occurred_on_msk: '2026-07-30', amount_rub: 300 }),
      ],
      'week',
      { from: '2026-07-01', to: '2026-07-31' },
      null,
    );
    expect(s.series).toEqual([
      { bucket: '2026-06-29', total: 100, bySource: { tochka: 100 }, partial: true },
      { bucket: '2026-07-13', total: 200, bySource: { tochka: 200 }, partial: false },
      { bucket: '2026-07-27', total: 300, bySource: { tochka: 300 }, partial: true },
    ]);
  });
});

describe('breakdownByPayer', () => {
  it('один ИНН и разные написания имени — одна строка отчёта', () => {
    // Реальный случай из данных: один и тот же человек приходит то как
    // «Ерхов Никита Владимирович», то как «ЕРХОВ НИКИТА».
    const items = breakdownByPayer(
      [
        row({
          source_ref: 'a',
          counterparty: 'Ерхов Никита Владимирович',
          counterparty_inn: '770123456789',
          amount_rub: 300,
        }),
        row({
          source_ref: 'b',
          counterparty: 'ЕРХОВ НИКИТА',
          counterparty_inn: '770123456789',
          amount_rub: 200,
        }),
      ],
      [],
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      payerInn: '770123456789',
      payerName: 'Ерхов Никита Владимирович',
      total: 500,
      ops: 2,
      share: 1,
    });
  });

  it('плательщик без ИНН группируется по имени', () => {
    const items = breakdownByPayer(
      [
        row({ source_ref: 'a', counterparty: 'Иванов Пётр', counterparty_inn: null, amount_rub: 100 }),
        row({ source_ref: 'b', counterparty: 'ИВАНОВ ПЁТР', counterparty_inn: null, amount_rub: 50 }),
        row({ source_ref: 'c', counterparty: 'Сидоров Иван', counterparty_inn: null, amount_rub: 40 }),
      ],
      [],
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ payerInn: null, payerName: 'Иванов Пётр', total: 150, ops: 2 });
    expect(items[1]).toMatchObject({ payerName: 'Сидоров Иван', total: 40 });
  });

  it('имя из одних цифр не склеивается с чужим ИНН', () => {
    const items = breakdownByPayer(
      [
        row({ source_ref: 'a', counterparty: 'ООО Ромашка', counterparty_inn: '7701234567', amount_rub: 100 }),
        row({ source_ref: 'b', counterparty: '7701234567', counterparty_inn: null, amount_rub: 70 }),
      ],
      [],
    );
    expect(items).toHaveLength(2);
  });

  it('не-выручка в разбивку не попадает', () => {
    const items = breakdownByPayer([nonRevenue({ amount_rub: 900 })], []);
    expect(items).toEqual([]);
  });

  it('считает долю и дельту к прошлому периоду', () => {
    const items = breakdownByPayer(
      [
        row({ source_ref: 'a', amount_rub: 300 }),
        row({
          source_ref: 'b',
          counterparty: 'ООО Василёк',
          counterparty_inn: '7709999999',
          amount_rub: 100,
        }),
      ],
      [row({ source_ref: 'p', amount_rub: 200 })],
    );
    expect(items[0]).toMatchObject({ payerName: 'ООО Ромашка', total: 300, share: 0.75, deltaPrev: 0.5 });
    expect(items[1]).toMatchObject({ payerName: 'ООО Василёк', total: 100, deltaPrev: null });
  });

  it('плательщик, пропавший в текущем периоде, показывается с total=0 и deltaPrev=-1', () => {
    // Отвалившийся клиент — самое ценное, что видно в разбивке дохода.
    const items = breakdownByPayer(
      [row({ source_ref: 'a', amount_rub: 100 })],
      [
        row({ source_ref: 'p1', amount_rub: 100 }),
        row({
          source_ref: 'p2',
          counterparty: 'ООО Бывший клиент',
          counterparty_inn: '7705555555',
          amount_rub: 500,
        }),
      ],
    );
    const churned = items.find((i) => i.payerInn === '7705555555');
    expect(churned).toMatchObject({
      payerName: 'ООО Бывший клиент',
      total: 0,
      ops: 0,
      share: 0,
      deltaPrev: -1,
    });
  });

  it('строка без курса не считается нулём: видна отдельным счётчиком', () => {
    const items = breakdownByPayer(
      [
        row({ source_ref: 'a', amount_rub: 5000 }),
        row({ source_ref: 'b', currency: 'USD', amount: 5000, amount_rub: null }),
      ],
      [],
    );
    expect(items[0]).toMatchObject({
      total: 5000,
      ops: 2,
      unconvertedCount: 1,
      unconvertedByCurrency: { USD: 5000 },
    });
  });

  it('платежи без имени и ИНН собираются в одну кучу без дельты', () => {
    const items = breakdownByPayer(
      [row({ counterparty: null, counterparty_inn: null, amount_rub: 60 })],
      [row({ source_ref: 'p', counterparty: null, counterparty_inn: null, amount_rub: 999 })],
    );
    expect(items[0]).toMatchObject({
      payerKey: '',
      payerInn: null,
      payerName: 'Плательщик не указан',
      total: 60,
      deltaPrev: null,
    });
  });
});

/** @jest-environment node */

import {
  getPaymentMonthLimit,
  summarizePaymentMonth,
  type PaymentBudgetRow,
} from '@/lib/payments/budget';

function payment(overrides: Partial<PaymentBudgetRow> = {}): PaymentBudgetRow {
  return {
    amount: 1_000,
    status: 'approved',
    expenseType: 'one_time',
    expectedPaymentOn: '2026-08-15',
    paidOn: null,
    ...overrides,
  };
}

describe('getPaymentMonthLimit', () => {
  it.each([
    ['2026-01', 40_000],
    ['2026-02', 75_000],
    ['2026-03', 75_000],
    ['2026-04', 75_000],
    ['2026-05', 40_000],
    ['2026-06', 75_000],
    ['2026-07', 75_000],
    ['2026-08', 75_000],
    ['2026-09', 75_000],
    ['2026-10', 75_000],
    ['2026-11', 75_000],
    ['2026-12', 40_000],
  ])('returns the global company limit for %s', (month, expected) => {
    expect(getPaymentMonthLimit(month)).toBe(expected);
  });

  it.each(['0000-01', '0999-12', '2026-00', '2026-13', '2026-8', '08-2026', 'not-a-month']) (
    'rejects a non-canonical Moscow calendar month: %s',
    (month) => {
      expect(() => getPaymentMonthLimit(month)).toThrow();
    },
  );
});

describe('summarizePaymentMonth', () => {
  it('uses paidOn for paid one-time fact and expectedPaymentOn for approved reserve', () => {
    const summary = summarizePaymentMonth([
      payment({ amount: 12_000, status: 'paid', paidOn: '2026-08-20' }),
      payment({ amount: 8_000, status: 'approved', expectedPaymentOn: '2026-08-21' }),
    ], '2026-08');

    expect(summary).toEqual(expect.objectContaining({
      limit: 75_000,
      paidOneTime: 12_000,
      reservedOneTime: 8_000,
      usedOneTime: 20_000,
      remaining: 55_000,
      overage: 0,
      paidAll: 12_000,
      pendingCount: 0,
      approvedCount: 1,
    }));
  });

  it('does not count planned expenses against the one-time limit but keeps paid planned expenses in paidAll', () => {
    const summary = summarizePaymentMonth([
      payment({
        amount: 10_000,
        expenseType: 'planned',
        status: 'approved',
      }),
      payment({
        amount: 15_000,
        expenseType: 'planned',
        status: 'paid',
        paidOn: '2026-08-18',
      }),
    ], '2026-08');

    expect(summary).toEqual(expect.objectContaining({
      paidOneTime: 0,
      reservedOneTime: 0,
      usedOneTime: 0,
      remaining: 75_000,
      paidAll: 15_000,
      approvedCount: 1,
    }));
  });

  it('excludes pending and rejected rows from both reserve and paid fact', () => {
    const summary = summarizePaymentMonth([
      payment({ amount: 7_000, status: 'pending' }),
      payment({ amount: 9_000, status: 'rejected', paidOn: '2026-08-18' }),
    ], '2026-08');

    expect(summary).toEqual(expect.objectContaining({
      paidOneTime: 0,
      reservedOneTime: 0,
      usedOneTime: 0,
      paidAll: 0,
      pendingCount: 1,
      approvedCount: 0,
    }));
  });

  it('conservatively counts paid legacy rows as one-time until Anya classifies them', () => {
    const legacy = payment({
      amount: 14_000,
      status: 'paid',
      expenseType: 'legacy_unclassified',
      paidOn: '2026-08-08',
    });

    expect(summarizePaymentMonth([legacy], '2026-08')).toEqual(expect.objectContaining({
      paidOneTime: 14_000,
      usedOneTime: 14_000,
      legacyCount: 1,
      legacyAmount: 14_000,
    }));

    expect(summarizePaymentMonth([
      { ...legacy, expenseType: 'planned' },
    ], '2026-08')).toEqual(expect.objectContaining({
      paidOneTime: 0,
      usedOneTime: 0,
      legacyCount: 0,
      legacyAmount: 0,
      paidAll: 14_000,
    }));
  });

  it('moves one-time consumption to the real paid month without double-counting the old reserve month', () => {
    const crossMonth = payment({
      amount: 20_000,
      status: 'paid',
      expectedPaymentOn: '2026-07-31',
      paidOn: '2026-08-01',
    });

    expect(summarizePaymentMonth([crossMonth], '2026-07')).toEqual(expect.objectContaining({
      paidOneTime: 0,
      reservedOneTime: 0,
      usedOneTime: 0,
      paidAll: 0,
    }));
    expect(summarizePaymentMonth([crossMonth], '2026-08')).toEqual(expect.objectContaining({
      paidOneTime: 20_000,
      reservedOneTime: 0,
      usedOneTime: 20_000,
      paidAll: 20_000,
    }));
  });

  it.each([
    [59_999, 'normal'],
    [60_000, 'warning'],
    [75_000, 'warning'],
    [75_001, 'exceeded'],
  ] as const)('classifies usage %d as %s at exact 80/100 percent boundaries', (amount, level) => {
    const summary = summarizePaymentMonth([
      payment({ amount, status: 'approved' }),
    ], '2026-08');

    expect(summary.level).toBe(level);
    expect(summary.remaining).toBe(75_000 - amount);
    expect(summary.overage).toBe(Math.max(amount - 75_000, 0));
    expect(summary.usagePct).toBeCloseTo((amount / 75_000) * 100, 5);
  });

  it('keeps remaining signed and overage nonnegative after an approved exception', () => {
    const summary = summarizePaymentMonth([
      payment({ amount: 90_000, status: 'approved' }),
    ], '2026-08');

    expect(summary).toEqual(expect.objectContaining({
      remaining: -15_000,
      overage: 15_000,
      level: 'exceeded',
    }));
  });
});

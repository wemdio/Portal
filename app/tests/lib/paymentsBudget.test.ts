/** @jest-environment node */

import {
  getPaymentCostMonthLimit,
  getPaymentMonthLimit,
  summarizePaymentMonth,
  type PaymentCalendarCostRow,
  type PaymentBudgetRow,
} from '@/lib/payments/budget';
import { paymentSummaryToApi } from '@/lib/payments/server';

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

function calendarCost(
  overrides: Partial<PaymentCalendarCostRow> = {},
): PaymentCalendarCostRow {
  return {
    source: 'mail',
    sourceId: 'calendar-1',
    costAmountRub: 8_000,
    status: 'keep',
    nextBillingDate: '2026-09-15',
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

describe('getPaymentCostMonthLimit', () => {
  it('uses the independent 650,000 RUB company cost limit in every month', () => {
    expect(getPaymentCostMonthLimit('2026-01')).toBe(650_000);
    expect(getPaymentCostMonthLimit('2026-09')).toBe(650_000);
    expect(getPaymentCostMonthLimit('2026-12')).toBe(650_000);
  });

  it('rejects a non-canonical month just like the one-time budget', () => {
    expect(() => getPaymentCostMonthLimit('2026-9')).toThrow();
  });
});

describe('paymentSummaryToApi', () => {
  it('defaults new tech-calendar totals to zero for older database payloads', () => {
    const summary = paymentSummaryToApi({ costBudget: {} });

    expect(summary.costBudget).toEqual(expect.objectContaining({
      techPaid: 0,
      techReserved: 0,
    }));
  });
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

  it('counts a recorded cost once in its actual paid month, outside the 75/40 thousand budget', () => {
    const summary = summarizePaymentMonth([
      payment({
        amount: 120_000,
        status: 'paid',
        budgetScope: 'costs',
        costCategory: 'instantly',
        expectedPaymentOn: '2026-08-31',
        paidOn: '2026-09-01',
      }),
    ], '2026-09', { asOf: '2026-09-10' });

    expect(summary).toEqual(expect.objectContaining({
      limit: 75_000,
      usedOneTime: 0,
      remaining: 75_000,
      paidAll: 120_000,
    }));
    expect(summary.costBudget).toEqual(expect.objectContaining({
      limit: 650_000,
      paid: 120_000,
      reserved: 0,
      used: 120_000,
      remaining: 530_000,
    }));
    expect(summary.costBudget.byCategory.instantly).toEqual({ paid: 120_000, reserved: 0 });
  });

  it('treats calendar «keep» as mail reserve before billing and paid fact on the billing date', () => {
    const beforeBilling = summarizePaymentMonth([], '2026-09', {
      asOf: '2026-09-14',
      calendarCosts: [calendarCost()],
    });
    const onBillingDate = summarizePaymentMonth([], '2026-09', {
      asOf: '2026-09-15',
      calendarCosts: [calendarCost()],
    });

    expect(beforeBilling.costBudget).toEqual(expect.objectContaining({
      mailPaid: 0,
      mailReserved: 8_000,
      paid: 0,
      reserved: 8_000,
      used: 8_000,
    }));
    expect(onBillingDate.costBudget).toEqual(expect.objectContaining({
      mailPaid: 8_000,
      mailReserved: 0,
      paid: 8_000,
      reserved: 0,
      used: 8_000,
    }));
    expect(onBillingDate.paidAll).toBe(8_000);
  });

  it('counts a kept tech-calendar charge as «other»: reserved before billing and paid on the date', () => {
    const techCharge = calendarCost({
      source: 'tech',
      sourceId: 'tech:sub-1:2026-09-15',
    });

    const beforeBilling = summarizePaymentMonth([], '2026-09', {
      asOf: '2026-09-14',
      calendarCosts: [techCharge],
    });
    const onBillingDate = summarizePaymentMonth([], '2026-09', {
      asOf: '2026-09-15',
      calendarCosts: [techCharge],
    });

    expect(beforeBilling.costBudget).toEqual(expect.objectContaining({
      techPaid: 0,
      techReserved: 8_000,
      paid: 0,
      reserved: 8_000,
      used: 8_000,
    }));
    expect(beforeBilling.costBudget.byCategory.other).toEqual({ paid: 0, reserved: 8_000 });
    expect(onBillingDate.costBudget).toEqual(expect.objectContaining({
      techPaid: 8_000,
      techReserved: 0,
      paid: 8_000,
      reserved: 0,
      used: 8_000,
    }));
    expect(onBillingDate.costBudget.byCategory.other).toEqual({ paid: 8_000, reserved: 0 });
    expect(onBillingDate.paidAll).toBe(8_000);
  });

  it('keeps a paid tech ledger event in fact after renewal and does not double-count its current row', () => {
    const chargeKey = 'tech:sub-1:2026-09-15';
    const summary = summarizePaymentMonth([], '2026-09', {
      asOf: '2026-09-01',
      calendarCosts: [
        calendarCost({
          source: 'tech',
          sourceId: chargeKey,
          status: 'keep',
        }),
        calendarCost({
          source: 'tech',
          sourceId: chargeKey,
          status: 'paid',
        }),
        calendarCost({
          source: 'tech',
          sourceId: 'tech:sub-1:2026-10-15',
          status: 'active',
          nextBillingDate: '2026-10-15',
        }),
      ],
    });

    expect(summary.costBudget).toEqual(expect.objectContaining({
      techPaid: 8_000,
      techReserved: 0,
      paid: 8_000,
      reserved: 0,
      used: 8_000,
    }));
    expect(summary.costBudget.byCategory.other).toEqual({ paid: 8_000, reserved: 0 });
    expect(summary.paidAll).toBe(8_000);
  });

  it.each([
    ['paid first', ['paid', 'keep'] as const],
    ['paid last', ['keep', 'paid'] as const],
  ])('keeps the paid ledger event authoritative when a duplicate has missing FX: %s', (_label, statuses) => {
    const chargeKey = 'tech:sub-1:2026-09-15';
    const rows = statuses.map((status) => calendarCost({
      source: 'tech',
      sourceId: chargeKey,
      status,
      costAmountRub: status === 'paid' ? null : 8_000,
    }));
    const summary = summarizePaymentMonth([], '2026-09', {
      asOf: '2026-09-01',
      calendarCosts: rows,
    });

    expect(summary.costBudget.techPaid).toBe(0);
    expect(summary.costBudget.techReserved).toBe(0);
    expect(summary.costBudget.missingFxCount).toBe(1);
    expect(summary.costBudget.dataComplete).toBe(false);
  });

  it('does not consume the cost budget for active, pending-review, cancelled or other-month calendar rows', () => {
    const summary = summarizePaymentMonth([], '2026-09', {
      asOf: '2026-09-30',
      calendarCosts: [
        calendarCost({ sourceId: 'active', status: 'active' }),
        calendarCost({ sourceId: 'pending', status: 'pending_review' }),
        calendarCost({ sourceId: 'cancel', status: 'cancel' }),
        calendarCost({ sourceId: 'october', nextBillingDate: '2026-10-01' }),
      ],
    });

    expect(summary.costBudget).toEqual(expect.objectContaining({
      paid: 0,
      reserved: 0,
      used: 0,
      remaining: 650_000,
      mailPaid: 0,
      mailReserved: 0,
    }));
  });

  it('excludes non-kept tech-calendar rows from the cost budget', () => {
    const summary = summarizePaymentMonth([], '2026-09', {
      asOf: '2026-09-30',
      calendarCosts: [
        calendarCost({ source: 'tech', sourceId: 'active', status: 'active' }),
        calendarCost({ source: 'tech', sourceId: 'pending', status: 'pending_review' }),
        calendarCost({ source: 'tech', sourceId: 'cancel', status: 'cancel' }),
        calendarCost({ source: 'tech', sourceId: 'expired', status: 'expired' }),
      ],
    });

    expect(summary.costBudget).toEqual(expect.objectContaining({
      paid: 0,
      reserved: 0,
      used: 0,
      techPaid: 0,
      techReserved: 0,
    }));
    expect(summary.costBudget.byCategory.other).toEqual({ paid: 0, reserved: 0 });
  });

  it('deduplicates a calendar charge by its immutable source id', () => {
    const sameCharge = calendarCost({ sourceId: 'same-charge', costAmountRub: 1_000 });
    const summary = summarizePaymentMonth([], '2026-09', {
      asOf: '2026-09-01',
      calendarCosts: [sameCharge, { ...sameCharge }],
    });

    expect(summary.costBudget.mailReserved).toBe(1_000);
    expect(summary.costBudget.used).toBe(1_000);
  });

  it('keeps equal immutable ids from mail and tech as separate charges', () => {
    const summary = summarizePaymentMonth([], '2026-09', {
      asOf: '2026-09-01',
      calendarCosts: [
        calendarCost({ source: 'mail', sourceId: 'shared-id', costAmountRub: 1_000 }),
        calendarCost({ source: 'tech', sourceId: 'shared-id', costAmountRub: 2_000 }),
      ],
    });

    expect(summary.costBudget.mailReserved).toBe(1_000);
    expect(summary.costBudget.techReserved).toBe(2_000);
    expect(summary.costBudget.used).toBe(3_000);
  });

  it('fails closed when a foreign-currency calendar charge has no RUB rate', () => {
    const summary = summarizePaymentMonth([], '2026-09', {
      asOf: '2026-09-01',
      calendarCosts: [calendarCost({ costAmountRub: null })],
    });

    expect(summary.costBudget.missingFxCount).toBe(1);
    expect(summary.costBudget.dataComplete).toBe(false);
  });

  it('fails closed when a kept tech-calendar charge has no RUB rate', () => {
    const summary = summarizePaymentMonth([], '2026-09', {
      asOf: '2026-09-01',
      calendarCosts: [calendarCost({
        source: 'tech',
        sourceId: 'tech:missing-fx',
        costAmountRub: null,
      })],
    });

    expect(summary.costBudget.missingFxCount).toBe(1);
    expect(summary.costBudget.dataComplete).toBe(false);
    expect(summary.costBudget.techPaid).toBe(0);
    expect(summary.costBudget.techReserved).toBe(0);
  });

  it('rounds every frozen calendar charge to kopecks before aggregation', () => {
    const summary = summarizePaymentMonth([], '2026-09', {
      asOf: '2026-09-01',
      calendarCosts: [
        calendarCost({ sourceId: 'fraction-1', costAmountRub: 0.005 }),
        calendarCost({ sourceId: 'fraction-2', costAmountRub: 0.005 }),
      ],
    });

    expect(summary.costBudget.mailReserved).toBe(0.02);
    expect(summary.costBudget.used).toBe(0.02);
  });

  it.each([
    [650_000, 'warning', 0, 0],
    [650_000.01, 'exceeded', -0.01, 0.01],
  ] as const)(
    'uses exact cost-limit boundaries for %d',
    (amount, level, remaining, overage) => {
      const summary = summarizePaymentMonth([
        payment({
          amount,
          status: 'approved',
          budgetScope: 'costs',
          costCategory: 'domains',
          expectedPaymentOn: '2026-09-01',
        }),
      ], '2026-09', { asOf: '2026-09-01' });

      expect(summary.costBudget.level).toBe(level);
      expect(summary.costBudget.remaining).toBe(remaining);
      expect(summary.costBudget.overage).toBe(overage);
    },
  );
});

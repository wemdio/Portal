import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  summarizePaymentsFinanceMonth,
  type PaymentFinanceRow,
} from '@/lib/payments/finance';

function payment(overrides: Partial<PaymentFinanceRow> = {}): PaymentFinanceRow {
  const status = overrides.status ?? 'approved';
  return {
    id: 'payment-1',
    amount: 1_000,
    status,
    expenseType: 'one_time',
    expectedPaymentOn: '2026-08-15',
    paidOn: null,
    paidOnSource: status === 'paid' ? 'entered' : null,
    createdAt: '2026-08-01T08:00:00.000Z',
    updatedAt: '2026-08-01T08:00:00.000Z',
    ...overrides,
  };
}

describe('summarizePaymentsFinanceMonth', () => {
  it('считает в плане одобренные и оплаченные заявки по предполагаемой дате, а в факте — только оплаченные', () => {
    const approved = payment({ id: 'approved', amount: 1_000 });
    const paid = payment({
      id: 'paid',
      amount: 2_000,
      status: 'paid',
      paidOn: '2026-08-20',
    });

    const result = summarizePaymentsFinanceMonth([approved, paid], '2026-08');

    expect(result.plan).toMatchObject({ total: 3_000, count: 2 });
    expect(result.plan.items.map((item) => item.id).sort()).toEqual(['approved', 'paid']);
    expect(result.fact).toMatchObject({ total: 2_000, count: 1 });
    expect(result.fact.items.map((item) => item.id)).toEqual(['paid']);
  });

  it('при оплате в другом месяце оставляет план в предполагаемом месяце, а факт переносит в реальный месяц оплаты', () => {
    const row = payment({
      id: 'cross-month',
      amount: 5_000,
      status: 'paid',
      expectedPaymentOn: '2026-07-31',
      paidOn: '2026-08-01',
    });

    const july = summarizePaymentsFinanceMonth([row], '2026-07');
    const august = summarizePaymentsFinanceMonth([row], '2026-08');

    expect(july.plan).toMatchObject({ total: 5_000, count: 1 });
    expect(july.fact).toMatchObject({ total: 0, count: 0 });
    expect(august.plan).toMatchObject({ total: 0, count: 0 });
    expect(august.fact).toMatchObject({ total: 5_000, count: 1 });
  });

  it('не включает заявки на согласовании и отклонённые ни в план, ни в факт', () => {
    const pending = payment({
      id: 'pending',
      status: 'pending',
      paidOn: '2026-08-10',
    });
    const rejected = payment({
      id: 'rejected',
      status: 'rejected',
      paidOn: '2026-08-11',
    });

    const result = summarizePaymentsFinanceMonth([pending, rejected], '2026-08');

    expect(result.plan).toMatchObject({ total: 0, count: 0, items: [] });
    expect(result.fact).toMatchObject({ total: 0, count: 0, items: [] });
  });

  it.each([
    'one_time',
    'planned',
    'legacy_unclassified',
  ] as const)('учитывает в факте оплаченный расход типа %s', (expenseType) => {
    const row = payment({
      id: `paid-${expenseType}`,
      amount: 750,
      status: 'paid',
      expenseType,
      paidOn: '2026-08-18',
    });

    const result = summarizePaymentsFinanceMonth([row], '2026-08');

    expect(result.fact).toMatchObject({ total: 750, count: 1 });
    expect(result.fact.items.map((item) => item.id)).toEqual([`paid-${expenseType}`]);
  });

  it('учитывает legacy-строку по paidOn, не по createdAt на границе месяца', () => {
    const legacy = payment({
      id: 'legacy',
      amount: 1_250,
      status: 'paid',
      expenseType: 'legacy_unclassified',
      expectedPaymentOn: '2026-08-01',
      paidOn: '2026-08-01',
      paidOnSource: 'legacy_created_at',
      createdAt: '2026-07-31T20:30:00.000Z',
    });

    const july = summarizePaymentsFinanceMonth([legacy], '2026-07');
    const august = summarizePaymentsFinanceMonth([legacy], '2026-08');

    expect(july.fact).toMatchObject({ total: 0, count: 0 });
    expect(august.fact).toMatchObject({ total: 1_250, count: 1 });
  });

  it('не удваивает одну заявку, пришедшую из двух месячных API-ответов', () => {
    const paid = payment({
      id: 'same-month-paid',
      amount: 3_500,
      status: 'paid',
      paidOn: '2026-08-20',
      updatedAt: '2026-08-20T10:00:00.000Z',
    });
    const staleApprovedCopy = payment({
      id: 'same-month-paid',
      amount: 3_500,
      status: 'approved',
      paidOn: null,
      paidOnSource: null,
      updatedAt: '2026-08-19T10:00:00.000Z',
    });

    const result = summarizePaymentsFinanceMonth(
      [paid, { ...paid }, staleApprovedCopy],
      '2026-08',
    );

    expect(result.plan).toMatchObject({ total: 3_500, count: 1 });
    expect(result.fact).toMatchObject({ total: 3_500, count: 1 });
  });
});

describe('/finance integration contract', () => {
  const pageSource = readFileSync(resolve(process.cwd(), 'src/app/finance/page.tsx'), 'utf8');
  const layoutSource = readFileSync(resolve(process.cwd(), 'src/app/finance/layout.tsx'), 'utf8');

  it('keeps the unfinished implementation intact but redirects old bookmarks to «Оплаты»', () => {
    expect(layoutSource).toMatch(/redirect\(['"]\/payments['"]\)/);
    expect(layoutSource).not.toMatch(/children/);
    expect(pageSource).toMatch(/summarizePaymentsFinanceMonth|loadPayments|supabase/);
  });
});

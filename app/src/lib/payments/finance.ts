import type { PaymentRequest } from '@/lib/payments/types';

export type PaymentFinanceRow = Pick<
  PaymentRequest,
  | 'id'
  | 'amount'
  | 'status'
  | 'expenseType'
  | 'expectedPaymentOn'
  | 'paidOn'
  | 'paidOnSource'
  | 'createdAt'
  | 'updatedAt'
>;

export interface PaymentFinanceMeasure<T extends PaymentFinanceRow = PaymentFinanceRow> {
  total: number;
  count: number;
  items: T[];
}

export interface PaymentFinanceMonth<T extends PaymentFinanceRow = PaymentFinanceRow> {
  plan: PaymentFinanceMeasure<T>;
  fact: PaymentFinanceMeasure<T>;
}

function belongsToMonth(date: string | null, month: string): boolean {
  return date?.slice(0, 7) === month;
}

function updatedAtMillis(row: PaymentFinanceRow): number {
  const value = Date.parse(row.updatedAt);
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

/**
 * Builds the plan/fact projection used by every financial view.
 *
 * A paid request intentionally belongs to two independent measures: its plan
 * stays in the expected month, while its fact belongs to the actual payment
 * month. The monthly payments API can therefore return the same cross-month
 * request twice; de-duplicating by id here keeps every consumer consistent.
 */
export function summarizePaymentsFinanceMonth<T extends PaymentFinanceRow>(
  rows: readonly T[],
  month: string,
): PaymentFinanceMonth<T> {
  const uniqueRows = new Map<string, T>();

  for (const row of rows) {
    const existing = uniqueRows.get(row.id);
    if (!existing || updatedAtMillis(row) >= updatedAtMillis(existing)) {
      uniqueRows.set(row.id, row);
    }
  }

  const planItems: T[] = [];
  const factItems: T[] = [];

  for (const row of uniqueRows.values()) {
    if (
      (row.status === 'approved' || row.status === 'paid')
      && belongsToMonth(row.expectedPaymentOn, month)
    ) {
      planItems.push(row);
    }

    if (row.status === 'paid' && belongsToMonth(row.paidOn, month)) {
      factItems.push(row);
    }
  }

  const measure = (items: T[]): PaymentFinanceMeasure<T> => ({
    total: items.reduce((sum, item) => sum + item.amount, 0),
    count: items.length,
    items,
  });

  return {
    plan: measure(planItems),
    fact: measure(factItems),
  };
}

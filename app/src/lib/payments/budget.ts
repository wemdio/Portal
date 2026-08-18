import type {
  PaymentExpenseType,
  PaymentMonthSummary,
  PaymentRequestStatus,
} from './types';

const MONTH_RE = /^(\d{4})-(\d{2})$/;
const LOW_LIMIT_MONTHS = new Set([1, 5, 12]);

export interface PaymentBudgetRow {
  amount: number;
  status: PaymentRequestStatus;
  expenseType: PaymentExpenseType;
  expectedPaymentOn: string;
  paidOn: string | null;
}

function assertCanonicalMonth(month: string): number {
  const match = MONTH_RE.exec(month);
  const year = match ? Number(match[1]) : Number.NaN;
  const monthNumber = match ? Number(match[2]) : Number.NaN;
  if (!match || year < 1000 || year > 9999 || monthNumber < 1 || monthNumber > 12) {
    throw new Error('Payment month must use canonical YYYY-MM format');
  }
  return monthNumber;
}

function isInMonth(date: string | null, month: string): boolean {
  return date?.slice(0, 7) === month;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function getPaymentMonthLimit(month: string): number {
  const monthNumber = assertCanonicalMonth(month);
  return LOW_LIMIT_MONTHS.has(monthNumber) ? 40_000 : 75_000;
}

export function summarizePaymentMonth(
  rows: readonly PaymentBudgetRow[],
  month: string,
): PaymentMonthSummary {
  const limit = getPaymentMonthLimit(month);
  let paidOneTime = 0;
  let reservedOneTime = 0;
  let paidAll = 0;
  let legacyCount = 0;
  let legacyAmount = 0;
  let pendingCount = 0;
  let approvedCount = 0;

  for (const row of rows) {
    const amount = Number(row.amount);
    if (!Number.isFinite(amount)) continue;

    if (row.status === 'pending' && isInMonth(row.expectedPaymentOn, month)) {
      pendingCount += 1;
    }
    if (row.status === 'approved' && isInMonth(row.expectedPaymentOn, month)) {
      approvedCount += 1;
    }

    if (row.status === 'paid' && isInMonth(row.paidOn, month)) {
      paidAll += amount;
      if (row.expenseType === 'legacy_unclassified') {
        legacyCount += 1;
        legacyAmount += amount;
      }
      if (row.expenseType === 'one_time' || row.expenseType === 'legacy_unclassified') {
        paidOneTime += amount;
      }
      continue;
    }

    if (
      row.status === 'approved'
      && row.expenseType === 'one_time'
      && isInMonth(row.expectedPaymentOn, month)
    ) {
      reservedOneTime += amount;
    }
  }

  paidOneTime = roundMoney(paidOneTime);
  reservedOneTime = roundMoney(reservedOneTime);
  paidAll = roundMoney(paidAll);
  legacyAmount = roundMoney(legacyAmount);
  const usedOneTime = roundMoney(paidOneTime + reservedOneTime);
  const remaining = roundMoney(limit - usedOneTime);
  const overage = roundMoney(Math.max(usedOneTime - limit, 0));
  const usagePct = limit > 0 ? (usedOneTime / limit) * 100 : 0;
  const level = usagePct > 100
    ? 'exceeded'
    : usagePct >= 80
      ? 'warning'
      : 'normal';

  return {
    limit,
    paidOneTime,
    reservedOneTime,
    usedOneTime,
    remaining,
    overage,
    usagePct,
    level,
    legacyCount,
    legacyAmount,
    paidAll,
    pendingCount,
    approvedCount,
  };
}

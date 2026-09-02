import type {
  PaymentBudgetScope,
  PaymentCostCategory,
  PaymentCostCategoryTotals,
  PaymentExpenseType,
  PaymentMonthSummary,
  PaymentRequestStatus,
} from './types';

const MONTH_RE = /^(\d{4})-(\d{2})$/;
const LOW_LIMIT_MONTHS = new Set([1, 5, 12]);
const COST_MONTH_LIMIT = 650_000;

export interface PaymentBudgetRow {
  amount: number;
  status: PaymentRequestStatus;
  expenseType: PaymentExpenseType;
  expectedPaymentOn: string;
  paidOn: string | null;
  budgetScope?: PaymentBudgetScope;
  costCategory?: PaymentCostCategory | null;
}

export interface PaymentCalendarCostRow {
  source: 'mail' | 'tech';
  sourceId: string;
  costAmountRub: number | null;
  status: 'active' | 'pending_review' | 'keep' | 'cancel' | 'expired' | 'paid';
  nextBillingDate: string;
}

export interface SummarizePaymentMonthOptions {
  asOf?: string;
  calendarCosts?: readonly PaymentCalendarCostRow[];
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

export function getPaymentCostMonthLimit(month: string): number {
  assertCanonicalMonth(month);
  return COST_MONTH_LIMIT;
}

function emptyCategoryTotals(): PaymentCostCategoryTotals {
  return {
    instantly: { paid: 0, reserved: 0 },
    email: { paid: 0, reserved: 0 },
    bases: { paid: 0, reserved: 0 },
    domains: { paid: 0, reserved: 0 },
    other: { paid: 0, reserved: 0 },
  };
}

function calendarAmountRub(row: PaymentCalendarCostRow): number | null {
  if (row.costAmountRub === null) return null;
  const amount = Number(row.costAmountRub);
  return Number.isFinite(amount) && amount >= 0 ? roundMoney(amount) : null;
}

type CalendarCostSource = PaymentCalendarCostRow['source'];
type CalendarCostBucket = 'paid' | 'reserved';

const CALENDAR_SOURCE_CATEGORY: Record<CalendarCostSource, PaymentCostCategory> = {
  mail: 'email',
  tech: 'other',
};

function emptyCalendarSourceTotals(): Record<CalendarCostSource, {
  paid: number;
  reserved: number;
}> {
  return {
    mail: { paid: 0, reserved: 0 },
    tech: { paid: 0, reserved: 0 },
  };
}

function calendarChargeKey(row: PaymentCalendarCostRow): string {
  return `${row.source}:${row.sourceId}`;
}

function shouldReplaceCalendarCharge(
  current: PaymentCalendarCostRow,
  candidate: PaymentCalendarCostRow,
): boolean {
  const currentIsPaid = current.status === 'paid';
  const candidateIsPaid = candidate.status === 'paid';
  if (currentIsPaid !== candidateIsPaid) return candidateIsPaid;
  return calendarAmountRub(current) === null && calendarAmountRub(candidate) !== null;
}

function calendarCostsForMonth(
  rows: readonly PaymentCalendarCostRow[],
  month: string,
): PaymentCalendarCostRow[] {
  const charges = new Map<string, PaymentCalendarCostRow>();
  for (const row of rows) {
    if (
      (row.status !== 'keep' && row.status !== 'paid')
      || !isInMonth(row.nextBillingDate, month)
    ) continue;

    const key = calendarChargeKey(row);
    const current = charges.get(key);
    if (!current || shouldReplaceCalendarCharge(current, row)) {
      charges.set(key, row);
    }
  }
  return [...charges.values()];
}

export function summarizePaymentMonth(
  rows: readonly PaymentBudgetRow[],
  month: string,
  options: SummarizePaymentMonthOptions = {},
): PaymentMonthSummary {
  const limit = getPaymentMonthLimit(month);
  const costLimit = getPaymentCostMonthLimit(month);
  const asOf = options.asOf ?? `${month}-01`;
  const byCategory = emptyCategoryTotals();
  let paidOneTime = 0;
  let reservedOneTime = 0;
  let paidAll = 0;
  let legacyCount = 0;
  let legacyAmount = 0;
  let pendingCount = 0;
  let approvedCount = 0;
  let manualCostPaid = 0;
  let manualCostReserved = 0;
  const calendarTotals = emptyCalendarSourceTotals();
  let missingFxCount = 0;

  for (const row of rows) {
    const amount = Number(row.amount);
    if (!Number.isFinite(amount)) continue;

    if (row.status === 'pending' && isInMonth(row.expectedPaymentOn, month)) {
      pendingCount += 1;
    }
    if (row.status === 'approved' && isInMonth(row.expectedPaymentOn, month)) {
      approvedCount += 1;
    }

    const isCost = row.budgetScope === 'costs';
    const costCategory = row.costCategory ?? 'other';

    if (row.status === 'paid' && isInMonth(row.paidOn, month)) {
      paidAll += amount;
      if (isCost) {
        manualCostPaid += amount;
        byCategory[costCategory].paid += amount;
        continue;
      }
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
      && isInMonth(row.expectedPaymentOn, month)
    ) {
      if (isCost) {
        manualCostReserved += amount;
        byCategory[costCategory].reserved += amount;
      } else if (row.expenseType === 'one_time') {
        reservedOneTime += amount;
      }
    }
  }

  for (const row of calendarCostsForMonth(options.calendarCosts ?? [], month)) {
    const amountRub = calendarAmountRub(row);
    if (amountRub === null) {
      missingFxCount += 1;
      continue;
    }
    const bucket: CalendarCostBucket = row.status === 'paid' || row.nextBillingDate <= asOf
      ? 'paid'
      : 'reserved';
    calendarTotals[row.source][bucket] += amountRub;
    byCategory[CALENDAR_SOURCE_CATEGORY[row.source]][bucket] += amountRub;
    if (bucket === 'paid') {
      paidAll += amountRub;
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
  manualCostPaid = roundMoney(manualCostPaid);
  manualCostReserved = roundMoney(manualCostReserved);
  for (const totals of Object.values(calendarTotals)) {
    totals.paid = roundMoney(totals.paid);
    totals.reserved = roundMoney(totals.reserved);
  }
  for (const totals of Object.values(byCategory)) {
    totals.paid = roundMoney(totals.paid);
    totals.reserved = roundMoney(totals.reserved);
  }
  const costPaid = roundMoney(
    manualCostPaid + calendarTotals.mail.paid + calendarTotals.tech.paid,
  );
  const costReserved = roundMoney(
    manualCostReserved + calendarTotals.mail.reserved + calendarTotals.tech.reserved,
  );
  const costUsed = roundMoney(costPaid + costReserved);
  const costRemaining = roundMoney(costLimit - costUsed);
  const costOverage = roundMoney(Math.max(costUsed - costLimit, 0));
  const costUsagePct = costLimit > 0 ? (costUsed / costLimit) * 100 : 0;
  const costLevel = costUsagePct > 100
    ? 'exceeded'
    : costUsagePct >= 80
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
    costBudget: {
      limit: costLimit,
      paid: costPaid,
      reserved: costReserved,
      used: costUsed,
      remaining: costRemaining,
      overage: costOverage,
      usagePct: costUsagePct,
      level: costLevel,
      dataComplete: missingFxCount === 0,
      missingFxCount,
      mailPaid: calendarTotals.mail.paid,
      mailReserved: calendarTotals.mail.reserved,
      techPaid: calendarTotals.tech.paid,
      techReserved: calendarTotals.tech.reserved,
      manualPaid: manualCostPaid,
      manualReserved: manualCostReserved,
      byCategory,
    },
  };
}

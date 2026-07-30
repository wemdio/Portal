import { differenceInCalendarDays, parseISO } from 'date-fns';

import { bucketKey, type GroupBy } from '@/lib/expenses/period';
import {
  TRANSFER_CATEGORIES,
  type ExpenseRow,
  type ExpensesSummary,
  type SeriesPoint,
  type VendorBreakdownItem,
} from '@/lib/expenses/types';

const UNCLASSIFIED_LABEL = 'Без категории';

function isTransfer(r: ExpenseRow): boolean {
  return r.category !== null && TRANSFER_CATEGORIES.includes(r.category);
}

function rub(r: ExpenseRow): number {
  return r.amount_rub ?? 0;
}

function sum(rows: ExpenseRow[]): number {
  return rows.reduce((acc, r) => acc + rub(r), 0);
}

function delta(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return (current - previous) / previous;
}

/**
 * Итоги и ряд по времени.
 *
 * Перемещения (category=transfer) исключаются из итога и из ряда, но
 * показываются отдельным числом: если их спрятать совсем, сумма перестанет
 * сходиться с банковской выпиской и проверить дашборд будет нечем.
 */
export function summarize(
  rows: ExpenseRow[],
  groupBy: GroupBy,
  range: { from: string; to: string },
  prevRows: ExpenseRow[] | null,
): ExpensesSummary {
  const spend = rows.filter((r) => !isTransfer(r));
  const transfers = rows.filter(isTransfer);

  const total = sum(spend);
  const days = differenceInCalendarDays(parseISO(range.to), parseISO(range.from)) + 1;

  const buckets = new Map<string, SeriesPoint>();
  for (const r of spend) {
    const key = bucketKey(r.occurred_on_msk, groupBy);
    const point = buckets.get(key) ?? { bucket: key, total: 0, byCategory: {}, bySource: {} };
    const value = rub(r);
    const category = r.category ?? 'unclassified';
    point.total += value;
    point.byCategory[category] = (point.byCategory[category] ?? 0) + value;
    point.bySource[r.source] = (point.bySource[r.source] ?? 0) + value;
    buckets.set(key, point);
  }

  const unclassified = spend.filter((r) => r.vendor_id === null);

  return {
    total,
    avgPerDay: days > 0 ? total / days : 0,
    deltaPrev: prevRows === null ? null : delta(total, sum(prevRows.filter((r) => !isTransfer(r)))),
    transfersTotal: sum(transfers),
    unclassifiedCount: unclassified.length,
    unclassifiedTotal: sum(unclassified),
    unconvertedCount: spend.filter((r) => r.amount_rub === null).length,
    series: [...buckets.values()].sort((a, b) => a.bucket.localeCompare(b.bucket)),
  };
}

/** Разбивка по вендорам с долей и дельтой к прошлому периоду. */
export function breakdownByVendor(rows: ExpenseRow[], prevRows: ExpenseRow[]): VendorBreakdownItem[] {
  const spend = rows.filter((r) => !isTransfer(r));
  const total = sum(spend);

  const prevByVendor = new Map<string, number>();
  for (const r of prevRows.filter((x) => !isTransfer(x))) {
    const key = r.vendor_id ?? '';
    prevByVendor.set(key, (prevByVendor.get(key) ?? 0) + rub(r));
  }

  const acc = new Map<string, VendorBreakdownItem>();
  for (const r of spend) {
    const key = r.vendor_id ?? '';
    const item = acc.get(key) ?? {
      vendorId: r.vendor_id,
      vendorName: r.vendor_name ?? UNCLASSIFIED_LABEL,
      category: r.category,
      total: 0,
      ops: 0,
      share: 0,
      deltaPrev: null,
    };
    item.total += rub(r);
    item.ops += 1;
    acc.set(key, item);
  }

  return [...acc.entries()]
    .map(([key, item]) => ({
      ...item,
      share: total > 0 ? item.total / total : 0,
      deltaPrev: delta(item.total, prevByVendor.get(key) ?? 0),
    }))
    .sort((a, b) => b.total - a.total);
}

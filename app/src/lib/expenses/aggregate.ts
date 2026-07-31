import { differenceInCalendarDays, endOfMonth, endOfWeek, format, parseISO } from 'date-fns';

import { bucketKey, type GroupBy } from '@/lib/expenses/period';
import {
  TRANSFER_CATEGORIES,
  UNCLASSIFIED_CATEGORY_KEY,
  type ExpenseCategory,
  type ExpenseRow,
  type ExpensesSummary,
  type SeriesPoint,
  type VendorBreakdownItem,
} from '@/lib/expenses/types';

const UNCLASSIFIED_LABEL = 'Без вендора';

function isTransfer(r: ExpenseRow): boolean {
  return r.category !== null && TRANSFER_CATEGORIES.includes(r.category);
}

/** Строка без курса ЦБ: amount_rub пуст. `== null`, а не `===`, — счётчик не
 *  должен молчать, если поле однажды придёт `undefined` вместо `null`
 *  (например, расползётся имя колонки витрины). Это ровно тот случай, когда
 *  страховка нужнее всего. */
function isUnconverted(r: ExpenseRow): boolean {
  return r.amount_rub == null;
}

/** Строка без привязанного вендора. См. isUnconverted про `== null`. */
function isUnclassified(r: ExpenseRow): boolean {
  return r.vendor_id == null;
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

function addToCurrencyMap(map: Record<string, number>, currency: string, amount: number): void {
  map[currency] = (map[currency] ?? 0) + amount;
}

/** Календарные границы бакета — нужны только чтобы определить partial, ключ группировки остаётся bucketKey. */
function bucketBounds(bucket: string, groupBy: GroupBy): { start: string; end: string } {
  if (groupBy === 'day') return { start: bucket, end: bucket };
  const start = parseISO(bucket);
  if (groupBy === 'week') {
    return { start: bucket, end: format(endOfWeek(start, { weekStartsOn: 1 }), 'yyyy-MM-dd') };
  }
  return { start: bucket, end: format(endOfMonth(start), 'yyyy-MM-dd') };
}

/** Бакет частичный, если его календарные границы выходят за пределы запрошенного периода. */
function isPartialBucket(bucket: string, groupBy: GroupBy, range: { from: string; to: string }): boolean {
  const { start, end } = bucketBounds(bucket, groupBy);
  return start < range.from || end > range.to;
}

/**
 * Итоги и ряд по времени.
 *
 * Перемещения (category=transfer) исключаются из итога и из ряда, но
 * показываются отдельным числом: если их спрятать совсем, сумма перестанет
 * сходиться с банковской выпиской и проверить дашборд будет нечем.
 *
 * Контракты, которые лежат на вызывающем (роуте):
 * - `rows` уже отфильтрованы по `range` — эта функция дат не проверяет и
 *   строки вне диапазона не отбрасывает, она их просто разложит по бакетам.
 * - если вызывающий применил фильтр по категории (например ?category=tools),
 *   то в выборке не будет строк transfer и `transfersTotal` окажется 0 —
 *   это не баг агрегации, а следствие фильтра выше по стеку.
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
    const point = buckets.get(key) ?? {
      bucket: key,
      total: 0,
      byCategory: {},
      bySource: {},
      partial: isPartialBucket(key, groupBy, range),
    };
    const value = rub(r);
    const category = r.category ?? UNCLASSIFIED_CATEGORY_KEY;
    point.total += value;
    point.byCategory[category] = (point.byCategory[category] ?? 0) + value;
    point.bySource[r.source] = (point.bySource[r.source] ?? 0) + value;
    buckets.set(key, point);
  }

  const unclassified = spend.filter(isUnclassified);
  const unconverted = spend.filter(isUnconverted);
  const unconvertedByCurrency: Record<string, number> = {};
  for (const r of unconverted) {
    addToCurrencyMap(unconvertedByCurrency, r.currency, r.amount);
  }

  return {
    total,
    avgPerDay: days > 0 ? total / days : 0,
    deltaPrev: prevRows === null ? null : delta(total, sum(prevRows.filter((r) => !isTransfer(r)))),
    transfersTotal: sum(transfers),
    unclassifiedCount: unclassified.length,
    unclassifiedTotal: sum(unclassified),
    unconvertedCount: unconverted.length,
    unconvertedByCurrency,
    series: [...buckets.values()].sort((a, b) => a.bucket.localeCompare(b.bucket)),
  };
}

interface PrevVendorTotal {
  total: number;
  vendorId: string | null;
  vendorName: string;
  category: ExpenseCategory | null;
}

/** Разбивка по вендорам с долей и дельтой к прошлому периоду. */
export function breakdownByVendor(rows: ExpenseRow[], prevRows: ExpenseRow[]): VendorBreakdownItem[] {
  const spend = rows.filter((r) => !isTransfer(r));
  const total = sum(spend);

  const prevByVendor = new Map<string, PrevVendorTotal>();
  for (const r of prevRows.filter((x) => !isTransfer(x))) {
    const key = r.vendor_id ?? '';
    const existing = prevByVendor.get(key);
    if (existing) {
      existing.total += rub(r);
    } else {
      prevByVendor.set(key, {
        total: rub(r),
        vendorId: r.vendor_id,
        vendorName: r.vendor_name ?? UNCLASSIFIED_LABEL,
        category: r.category,
      });
    }
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
      unconvertedCount: 0,
      unconvertedByCurrency: {},
    };
    item.total += rub(r);
    item.ops += 1;
    if (isUnconverted(r)) {
      item.unconvertedCount += 1;
      addToCurrencyMap(item.unconvertedByCurrency, r.currency, r.amount);
    }
    acc.set(key, item);
  }

  // Вендор, который тратил в прошлом периоде и не тратит в текущем, иначе
  // структурно не может попасть в отчёт — а именно это и есть отменённая
  // подписка или остановленная реклама, которую отчёт должен показать.
  for (const [key, prev] of prevByVendor) {
    if (acc.has(key)) continue;
    acc.set(key, {
      vendorId: prev.vendorId,
      vendorName: prev.vendorName,
      category: prev.category,
      total: 0,
      ops: 0,
      share: 0,
      deltaPrev: null,
      unconvertedCount: 0,
      unconvertedByCurrency: {},
    });
  }

  return [...acc.entries()]
    .map(([key, item]) => ({
      ...item,
      share: total > 0 ? item.total / total : 0,
      // Неразмеченное — это не один вендор, а меняющаяся со временем куча
      // разных операций; дельта между двумя такими кучами не измерение
      // тренда, а шум разметочной очереди. Поэтому для vendorId=null дельту
      // не считаем вовсе.
      deltaPrev: item.vendorId === null ? null : delta(item.total, prevByVendor.get(key)?.total ?? 0),
    }))
    .sort((a, b) => b.total - a.total);
}

import { addDays, differenceInCalendarDays, format, parseISO, startOfMonth, startOfWeek } from 'date-fns';

export type GroupBy = 'day' | 'week' | 'month';

export const GROUP_BY_VALUES: readonly GroupBy[] = ['day', 'week', 'month'] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Даты приходят и хранятся как YYYY-MM-DD в поясе Москвы (`occurred_on_msk`
 * витрины уже посчитан там же). Поэтому здесь ни таймзон, ни UTC-сдвигов:
 * работаем со строками и календарными днями.
 */
export function parseRange(from: string, to: string): { from: string; to: string } {
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
    throw new Error('Ожидается диапазон дат в формате YYYY-MM-DD');
  }
  if (from > to) {
    throw new Error('Начало диапазона позже конца');
  }
  return { from, to };
}

/** Предыдущий период той же длины, вплотную до начала текущего. */
export function previousRange(from: string, to: string): { from: string; to: string } {
  const start = parseISO(from);
  const end = parseISO(to);
  const lengthDays = differenceInCalendarDays(end, start) + 1;
  const prevEnd = addDays(start, -1);
  const prevStart = addDays(prevEnd, -(lengthDays - 1));
  return { from: format(prevStart, 'yyyy-MM-dd'), to: format(prevEnd, 'yyyy-MM-dd') };
}

/** Ключ бакета для группировки: начало дня, недели (с понедельника) или месяца. */
export function bucketKey(day: string, groupBy: GroupBy): string {
  const d = parseISO(day);
  if (groupBy === 'day') return day;
  if (groupBy === 'week') return format(startOfWeek(d, { weekStartsOn: 1 }), 'yyyy-MM-dd');
  return format(startOfMonth(d), 'yyyy-MM-dd');
}

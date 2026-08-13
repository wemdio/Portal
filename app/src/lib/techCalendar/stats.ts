/**
 * Счётчики и суммы для плиток календаря технички.
 *
 * Отменённые сервисы (`cancel`) не входят ни в деньги, ни в активные: решение
 * по ним принято, платить их не собираются. В календаре они при этом остаются
 * красными — чтобы техник дошёл и отключил.
 */
import { daysUntil } from '@/lib/techCalendar/dates';
import { addMoney, emptyTotals, type MoneyTotals } from '@/lib/techCalendar/money';
import {
  PENDING_REVIEW_DAYS,
  SERVICE_TYPES,
  type ServiceType,
  type TechSubscription,
} from '@/lib/techCalendar/types';

const UPCOMING_AHEAD_DAYS = 7;
const UPCOMING_BEHIND_DAYS = 3;

function isPayable(sub: TechSubscription): boolean {
  return sub.status !== 'cancel';
}

function inMonth(sub: TechSubscription, year: number, month: number): boolean {
  const [y, m] = sub.next_billing_date.split('-').map(Number);
  return y === year && m - 1 === month;
}

export function monthTotals(subs: TechSubscription[], year: number, month: number): MoneyTotals {
  return subs
    .filter((s) => isPayable(s) && inMonth(s, year, month))
    .reduce((acc, s) => addMoney(acc, s.currency, s.amount), emptyTotals());
}

export function totalsByType(
  subs: TechSubscription[],
  year: number,
  month: number,
): Record<ServiceType, MoneyTotals> {
  const result = Object.fromEntries(
    SERVICE_TYPES.map((t) => [t, emptyTotals()]),
  ) as Record<ServiceType, MoneyTotals>;

  for (const s of subs) {
    if (!isPayable(s) || !inMonth(s, year, month)) continue;
    result[s.service_type] = addMoney(result[s.service_type], s.currency, s.amount);
  }
  return result;
}

export function activeCount(subs: TechSubscription[]): number {
  return subs.filter(isPayable).length;
}

export function pendingCount(subs: TechSubscription[]): number {
  return subs.filter((s) => s.status === 'pending_review').length;
}

/** Сколько решений ждёт ответа в ближайшие `days` дней. Просрочка тоже ждёт. */
export function decisionsDueWithin(
  subs: TechSubscription[],
  todayStr: string,
  days: number = PENDING_REVIEW_DAYS,
): number {
  return subs.filter((s) => {
    if (s.status !== 'active' && s.status !== 'pending_review') return false;
    return daysUntil(s.next_billing_date, todayStr) <= days;
  }).length;
}

/** Список «ближайшие 7 дней»: неделя вперёд плюс три дня просрочки. */
export function upcoming(subs: TechSubscription[], todayStr: string): TechSubscription[] {
  return subs
    .filter((s) => {
      if (!isPayable(s)) return false;
      const d = daysUntil(s.next_billing_date, todayStr);
      return d >= -UPCOMING_BEHIND_DAYS && d <= UPCOMING_AHEAD_DAYS;
    })
    .sort((a, b) => a.next_billing_date.localeCompare(b.next_billing_date));
}

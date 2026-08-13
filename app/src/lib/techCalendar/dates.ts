/**
 * Арифметика дат календаря технички.
 *
 * Все функции работают со строками `YYYY-MM-DD` и считают по компонентам даты.
 * `new Date('2026-01-31')` — это полночь UTC, и на сервере в другом поясе
 * такая дата уезжает на сутки назад; в календаре платежей это ошибка на день
 * в обе стороны, а не косметика.
 */
import type { BillingCycle } from '@/lib/techCalendar/types';

const MSK_OFFSET_MINUTES = 3 * 60;

const CYCLE_MONTHS: Record<BillingCycle, number> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

interface DateParts {
  year: number;
  month: number; // 0-based
  day: number;
}

export function parseDateStr(dateStr: string): DateParts {
  const [y, m, d] = dateStr.split('-').map(Number);
  return { year: y, month: m - 1, day: d };
}

export function toDateStr(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function getDaysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** День недели первого числа месяца, где понедельник = 0. */
export function getFirstDayOfMonth(year: number, month: number): number {
  const day = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return day === 0 ? 6 : day - 1;
}

/**
 * Сдвиг на один цикл. Если в целевом месяце нет такого числа — берётся
 * последний день месяца: 31 января + месяц = 28 или 29 февраля.
 */
export function addCycle(dateStr: string, cycle: BillingCycle): string {
  const { year, month, day } = parseDateStr(dateStr);
  const shifted = month + CYCLE_MONTHS[cycle];
  const targetYear = year + Math.floor(shifted / 12);
  const targetMonth = ((shifted % 12) + 12) % 12;
  const maxDay = getDaysInMonth(targetYear, targetMonth);
  return toDateStr(targetYear, targetMonth, Math.min(day, maxDay));
}

/** Сколько целых дней от `todayStr` до `dateStr`. Прошлое — отрицательное. */
export function daysUntil(dateStr: string, todayStr: string): number {
  const a = parseDateStr(todayStr);
  const b = parseDateStr(dateStr);
  const aMs = Date.UTC(a.year, a.month, a.day);
  const bMs = Date.UTC(b.year, b.month, b.day);
  return Math.round((bMs - aMs) / 86_400_000);
}

/** Московская дата момента. Сервер живёт в UTC, а рабочий день — в МСК. */
export function mskDateStr(now: Date): string {
  const msk = new Date(now.getTime() + MSK_OFFSET_MINUTES * 60_000);
  return toDateStr(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate());
}

/** Сдвиг даты на N дней — для порогов «через 3 дня», «через неделю». */
export function addDays(dateStr: string, days: number): string {
  const { year, month, day } = parseDateStr(dateStr);
  const shifted = new Date(Date.UTC(year, month, day + days));
  return toDateStr(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
}

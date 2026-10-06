import { zonedParts } from '@/lib/sender/sendWindow';

/**
 * Арифметика автодобора без обращений к базе
 * (docs/superpowers/specs/2026-10-06-outreach-autofill-design.md, §1).
 */

/** Добор, когда базы осталось меньше чем на столько рабочих дней. */
export const AUTOFILL_TRIGGER_DAYS = 3;
/** Добор — на столько рабочих дней («неделя» при рассылке пн–пт). */
export const AUTOFILL_TARGET_DAYS = 5;
/** Потолок одного запуска автоаутрича (MAX_LIMIT обоих языков). */
export const AUTOFILL_MAX_TARGET = 1000;

export interface AutofillPlan {
  /** На сколько рабочих дней хватит базы; null — скорость 0 (нет рабочих ящиков). */
  daysLeft: number | null;
  needed: boolean;
  /** Сколько готовых компаний заказать у запуска. */
  target: number;
}

/** perDay — новых компаний в день (сумма «новых в день» ящиков папки), remaining — компаний без первого письма. */
export function planAutofill(input: { perDay: number; remaining: number }): AutofillPlan {
  const perDay = Math.max(0, Math.floor(input.perDay));
  const remaining = Math.max(0, Math.floor(input.remaining));
  if (perDay === 0) return { daysLeft: null, needed: false, target: 0 };
  return {
    daysLeft: remaining / perDay,
    needed: remaining < perDay * AUTOFILL_TRIGGER_DAYS,
    target: Math.min(AUTOFILL_MAX_TARGET, perDay * AUTOFILL_TARGET_DAYS),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Последний рабочий день, на который хватит базы: daysLeft рабочих дней
 * папки, считая с сегодняшнего (если он рабочий). Дата — YYYY-MM-DD в поясе
 * папки. Пустая база или нет скорости — null.
 */
export function baseUntil(now: Date, daysLeft: number | null, weekdays: number[], timezone: string): string | null {
  if (daysLeft === null || daysLeft <= 0) return null;
  const allowed = weekdays.length ? weekdays : [1, 2, 3, 4, 5];
  let need = Math.max(1, Math.ceil(daysLeft));
  // Полдень по UTC не перескакивает дату ни в одном поясе папок (МСК, Нью-Йорк).
  for (let i = 0; i < 400; i += 1) {
    const day = new Date(now.getTime() + i * DAY_MS);
    const p = zonedParts(day, timezone);
    if (!allowed.includes(p.weekday)) continue;
    need -= 1;
    if (need === 0) return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  }
  return null;
}

/** «2026-10-09» → «09.10». */
export function shortDate(isoDay: string | null): string {
  if (!isoDay) return '—';
  const [, month, day] = isoDay.split('-');
  return `${day}.${month}`;
}

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
/** Часы проверки базы по Москве. */
export const AUTOFILL_CHECK_HOURS_MSK = [9, 21];

/** День по Москве, YYYY-MM-DD (МСК — UTC+3 без перехода на летнее время). */
export function mskDay(now: Date): string {
  return new Date(now.getTime() + MSK_OFFSET_MS).toISOString().slice(0, 10);
}

/** Последний час проверки (09:00 или 21:00 МСК) не позже now. */
export function latestCheckSlot(now: Date): Date {
  const msk = new Date(now.getTime() + MSK_OFFSET_MS);
  const hours = [...AUTOFILL_CHECK_HOURS_MSK].sort((a, b) => b - a);
  for (let back = 0; back < 2; back += 1) {
    const base = Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate() - back);
    for (const hour of hours) {
      const slot = base + hour * 60 * 60 * 1000 - MSK_OFFSET_MS;
      if (slot <= now.getTime()) return new Date(slot);
    }
  }
  return new Date(now.getTime() - DAY_MS);
}

/**
 * Окно отправки кампании: рабочие часы, разрешённые дни недели и часовой пояс.
 * Чистые функции без обращений к БД — вся арифметика времени живёт здесь.
 */

export interface SendWindow {
  timezone: string;
  /** Час начала окна включительно, час конца — не включая. */
  sendHourFrom: number;
  sendHourTo: number;
  /** 1 = понедельник … 7 = воскресенье. */
  sendWeekdays: number[];
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
};

function localParts(date: Date, timezone: string): LocalParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // В en-US полночь форматируется как «24» — приводим к 0.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAY_INDEX[parts.weekday as string] ?? 1,
  };
}

/** Смещение зоны в минутах для конкретного момента (с учётом перехода на летнее время). */
function timezoneOffsetMinutes(date: Date, timezone: string): number {
  const p = localParts(date, timezone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  // Секунды в исходной дате не участвуют: окно считаем с точностью до минуты.
  const base = Math.floor(date.getTime() / 60_000) * 60_000;
  return (asUtc - base) / 60_000;
}

/** Момент, соответствующий заданному локальному времени в зоне кампании. */
function fromLocal(parts: { year: number; month: number; day: number; hour: number; minute: number }, timezone: string): Date {
  const guess = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute));
  const offset = timezoneOffsetMinutes(guess, timezone);
  const exact = new Date(guess.getTime() - offset * 60_000);
  // Повторный проход снимает случай, когда первая оценка попала в другой
  // offset (переход на летнее время внутри суток).
  const offset2 = timezoneOffsetMinutes(exact, timezone);
  return offset2 === offset ? exact : new Date(guess.getTime() - offset2 * 60_000);
}

export function isWithinWindow(date: Date, window: SendWindow): boolean {
  const p = localParts(date, window.timezone);
  if (!window.sendWeekdays.includes(p.weekday)) return false;
  return p.hour >= window.sendHourFrom && p.hour < window.sendHourTo;
}

/**
 * Ближайший момент внутри окна отправки: сам `date`, если он уже в окне,
 * иначе начало ближайшего разрешённого окна. Смотрим максимум на две недели
 * вперёд — этого хватает при любом наборе дней недели.
 */
export function nextWindowSlot(date: Date, window: SendWindow): Date {
  if (isWithinWindow(date, window)) return date;

  const weekdays = window.sendWeekdays.length ? window.sendWeekdays : [1, 2, 3, 4, 5];
  let cursor = new Date(date);

  for (let i = 0; i < 15; i += 1) {
    const p = localParts(cursor, window.timezone);
    const allowedDay = weekdays.includes(p.weekday);

    if (allowedDay && p.hour < window.sendHourFrom) {
      return fromLocal({ ...p, hour: window.sendHourFrom, minute: 0 }, window.timezone);
    }
    if (allowedDay && p.hour >= window.sendHourFrom && p.hour < window.sendHourTo) {
      return cursor;
    }

    // День не подходит или окно уже закрылось — переходим к следующим суткам.
    const nextDay = fromLocal({ ...p, hour: window.sendHourFrom, minute: 0 }, window.timezone);
    cursor = new Date(nextDay.getTime() + 24 * 60 * 60 * 1000);
  }

  return cursor;
}

/** Пауза между письмами: база плюс случайная добавка, чтобы не было ровного ритма. */
export function nextGapMs(gapSeconds: number, jitterSeconds: number): number {
  const jitter = jitterSeconds > 0 ? Math.floor(Math.random() * jitterSeconds) : 0;
  return (gapSeconds + jitter) * 1000;
}

/**
 * Периоды отчётности дашборда «2GIS + сигналы» (Europe/Moscow).
 *
 * Два семейства границ:
 *   - произвольный период для воронки/среза/грейдов: пресеты 7d / 30d / all /
 *     custom (свои даты). Календарные границы — по Москве, в БД уходят точные
 *     UTC-моменты ([fromUtc; toExclusiveUtc)).
 *   - календарная неделя для «Недельного отчёта»: пн 00:00 — вс 23:59 МСК,
 *     переключатель «эта / прошлая». Дельты считаются к равному предыдущему
 *     интервалу (предшествующие 7/30/N дней; для 'all' дельт нет).
 *
 * Самодостаточный модуль (пайплайн изолирован от остальных стеков): московская
 * полночь вычисляется через смещение таймзоны из Intl, без жёсткого +03:00.
 * Чистые функции, БД нет — легко тестируется.
 */

export const GIS_REPORT_TIME_ZONE = 'Europe/Moscow' as const;

export const GIS_REPORT_PERIOD_PRESETS = ['7d', '30d', 'all', 'custom'] as const;
export type GisReportPeriodPreset = (typeof GIS_REPORT_PERIOD_PRESETS)[number];

export const GIS_WEEK_IDS = ['current', 'previous'] as const;
export type GisWeekId = (typeof GIS_WEEK_IDS)[number];

export interface GisReportPeriod {
  preset: GisReportPeriodPreset;
  /** Начало периода YYYY-MM-DD (Москва); null у 'all'. */
  from: string | null;
  /** Конец периода YYYY-MM-DD (Москва), включительно; null у 'all'. */
  to: string | null;
  /** UTC-момент московской полночи начала; null у 'all'. */
  fromUtc: Date | null;
  /** UTC-момент московской полночи дня после конца (исключительно); null у 'all'. */
  toExclusiveUtc: Date | null;
  /** Длина периода в днях (для дельт к предыдущему равному); null у 'all'. */
  days: number | null;
}

export interface GisWeekRange {
  weekId: GisWeekId;
  /** Понедельник недели YYYY-MM-DD (Москва). */
  weekStart: string;
  /** Воскресенье недели YYYY-MM-DD (Москва). */
  weekEnd: string;
  /** Пн 00:00 МСК в UTC. */
  fromUtc: Date;
  /** Пн следующей недели 00:00 МСК в UTC (исключительно). */
  toExclusiveUtc: Date;
  /** Начало предыдущей недели (для дельт). */
  prevFromUtc: Date;
  /** Конец предыдущей недели = начало текущей (исключительно). */
  prevToExclusiveUtc: Date;
}

export class GisReportPeriodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GisReportPeriodError';
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CUSTOM_DAYS = 366;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const MOSCOW_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: GIS_REPORT_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const MOSCOW_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: GIS_REPORT_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

interface CalendarDate {
  iso: string;
  year: number;
  month: number;
  day: number;
  /** Порядковый номер дня (UTC-эпоха / DAY_MS) — для сравнений и арифметики. */
  dayNumber: number;
}

function partsRecord(
  formatter: Intl.DateTimeFormat,
  date: Date,
): Record<string, string> {
  return Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
}

function utcMsForCalendarParts(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}

function formatCalendarDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Строгий разбор YYYY-MM-DD с проверкой реальности даты (2026-02-30 отклоняется). */
function parseCalendarDate(value: unknown, field: string): CalendarDate {
  if (typeof value !== 'string') {
    throw new GisReportPeriodError(`${field} must be a valid date in YYYY-MM-DD format`);
  }
  const match = ISO_DATE_RE.exec(value);
  if (!match) {
    throw new GisReportPeriodError(`${field} must be a valid date in YYYY-MM-DD format`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new GisReportPeriodError(`${field} must be a valid date in YYYY-MM-DD format`);
  }
  const timestamp = utcMsForCalendarParts(year, month, day);
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() + 1 !== month
    || date.getUTCDate() !== day
  ) {
    throw new GisReportPeriodError(`${field} must be a valid date in YYYY-MM-DD format`);
  }
  return { iso: value, year, month, day, dayNumber: Math.floor(timestamp / DAY_MS) };
}

function addCalendarDays(iso: string, amount: number): string {
  const date = parseCalendarDate(iso, 'date');
  const shifted = new Date(utcMsForCalendarParts(date.year, date.month, date.day + amount));
  return formatCalendarDate(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
  );
}

/** Календарная дата в Москве для момента времени. */
export function moscowCalendarDate(now: Date): string {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new GisReportPeriodError('now must be a valid Date');
  }
  const parts = partsRecord(MOSCOW_DATE_FORMATTER, now);
  return formatCalendarDate(Number(parts.year), Number(parts.month), Number(parts.day));
}

/** Смещение московского локального времени относительно UTC в данный момент (мс). */
function moscowOffsetMs(at: Date): number {
  const parts = partsRecord(MOSCOW_DATE_TIME_FORMATTER, at);
  const localAsUtc = utcMsForCalendarParts(
    Number(parts.year),
    Number(parts.month),
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const withoutMilliseconds = Math.floor(at.getTime() / 1_000) * 1_000;
  return localAsUtc - withoutMilliseconds;
}

/** Точный UTC-момент московской полночи указанной календарной даты. */
function moscowMidnightUtc(iso: string): Date {
  const calendar = parseCalendarDate(iso, 'date');
  const localAsUtc = utcMsForCalendarParts(calendar.year, calendar.month, calendar.day);
  let candidate = localAsUtc - moscowOffsetMs(new Date(localAsUtc));
  // Второй проход — на случай смены смещения рядом с границей.
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const adjusted = localAsUtc - moscowOffsetMs(new Date(candidate));
    if (adjusted === candidate) break;
    candidate = adjusted;
  }
  return new Date(candidate);
}

function isPeriodPreset(value: unknown): value is GisReportPeriodPreset {
  return (
    typeof value === 'string'
    && (GIS_REPORT_PERIOD_PRESETS as readonly string[]).includes(value)
  );
}

/**
 * Резолвит период из query/UI-значений. preset по умолчанию '7d' (дефолт
 * дашборда). Невалидный ввод — GisReportPeriodError (роут отвечает 400,
 * а не молча расширяет выборку до «всё время»).
 */
export function resolveGisReportPeriod(
  input: { preset?: unknown; from?: unknown; to?: unknown },
  now: Date = new Date(),
): GisReportPeriod {
  const preset = input.preset === undefined ? '7d' : input.preset;
  if (!isPeriodPreset(preset)) {
    throw new GisReportPeriodError(`Unsupported period preset: ${String(preset)}`);
  }

  if (preset === 'all') {
    return { preset, from: null, to: null, fromUtc: null, toExclusiveUtc: null, days: null };
  }

  const today = moscowCalendarDate(now);
  let from: string;
  let to: string;

  if (preset === '7d') {
    from = addCalendarDays(today, -6);
    to = today;
  } else if (preset === '30d') {
    from = addCalendarDays(today, -29);
    to = today;
  } else {
    if (input.from === undefined || input.to === undefined) {
      throw new GisReportPeriodError('Custom period requires both from and to');
    }
    const parsedFrom = parseCalendarDate(input.from, 'from');
    const parsedTo = parseCalendarDate(input.to, 'to');
    if (parsedFrom.dayNumber > parsedTo.dayNumber) {
      throw new GisReportPeriodError('from must not be after to');
    }
    const inclusiveDays = parsedTo.dayNumber - parsedFrom.dayNumber + 1;
    if (inclusiveDays > MAX_CUSTOM_DAYS) {
      throw new GisReportPeriodError(`Custom period cannot exceed ${MAX_CUSTOM_DAYS} days`);
    }
    from = parsedFrom.iso;
    to = parsedTo.iso;
  }

  const fromDay = parseCalendarDate(from, 'from');
  const toDay = parseCalendarDate(to, 'to');
  return {
    preset,
    from,
    to,
    fromUtc: moscowMidnightUtc(from),
    toExclusiveUtc: moscowMidnightUtc(addCalendarDays(to, 1)),
    days: toDay.dayNumber - fromDay.dayNumber + 1,
  };
}

/**
 * Предыдущий равный интервал для дельт: [fromUtc − days; fromUtc).
 * Для 'all' (days=null) дельт нет → null.
 */
export function previousGisPeriodRange(
  period: GisReportPeriod,
): { fromUtc: Date; toExclusiveUtc: Date } | null {
  if (period.days === null || !period.fromUtc) return null;
  return {
    fromUtc: new Date(period.fromUtc.getTime() - period.days * DAY_MS),
    toExclusiveUtc: period.fromUtc,
  };
}

/**
 * Календарная неделя (пн–вс, Москва). week по умолчанию 'current';
 * 'previous' — предыдущая календарная неделя. prev*-поля — неделя перед
 * выбранной (для дельт «к прошлой неделе»).
 */
export function resolveGisWeek(week: unknown, now: Date = new Date()): GisWeekRange {
  const weekId = week === undefined ? 'current' : week;
  if (typeof weekId !== 'string' || !(GIS_WEEK_IDS as readonly string[]).includes(weekId)) {
    throw new GisReportPeriodError(`Unsupported week: ${String(weekId)}`);
  }

  const todayIso = moscowCalendarDate(now);
  const today = parseCalendarDate(todayIso, 'date');
  // День недели по UTC-полуночи календарной даты: 0=вс..6=сб → отступ до пн.
  const weekday = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
  const mondayOffset = (weekday + 6) % 7;
  let monday = addCalendarDays(todayIso, -mondayOffset);
  if (weekId === 'previous') monday = addCalendarDays(monday, -7);
  const sunday = addCalendarDays(monday, 6);

  const fromUtc = moscowMidnightUtc(monday);
  return {
    weekId: weekId as GisWeekId,
    weekStart: monday,
    weekEnd: sunday,
    fromUtc,
    toExclusiveUtc: moscowMidnightUtc(addCalendarDays(monday, 7)),
    prevFromUtc: moscowMidnightUtc(addCalendarDays(monday, -7)),
    prevToExclusiveUtc: fromUtc,
  };
}

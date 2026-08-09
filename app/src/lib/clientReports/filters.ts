export const REPORT_TIME_ZONE = 'Europe/Moscow' as const;

export const CLIENT_REPORT_PERIOD_PRESETS = [
  'last_7_days',
  'last_30_days',
  'current_month',
  'previous_month',
  'custom',
] as const;

export const CLIENT_REPORT_SCORE_FILTERS = ['all', 'A', 'B', 'C'] as const;

export type ClientReportPeriodPreset = (typeof CLIENT_REPORT_PERIOD_PRESETS)[number];
export type ClientReportScoreFilter = (typeof CLIENT_REPORT_SCORE_FILTERS)[number];
export type ClientReportScoreCode = Exclude<ClientReportScoreFilter, 'all'> | 'rejected';

export type ClientReportFilterInput = {
  preset: unknown;
  from?: unknown;
  to?: unknown;
  score: unknown;
  campaignId?: unknown;
};

export type ClientReportPeriod = {
  preset: ClientReportPeriodPreset;
  /** Inclusive calendar boundary in Europe/Moscow, formatted as YYYY-MM-DD. */
  from: string;
  /** Inclusive calendar boundary in Europe/Moscow, formatted as YYYY-MM-DD. */
  to: string;
  /** Inclusive UTC instant for database predicates (`event_at >= fromUtc`). */
  fromUtc: Date;
  /** Exclusive UTC instant for database predicates (`event_at < toExclusiveUtc`). */
  toExclusiveUtc: Date;
};

export type ClientReportFilters = {
  period: ClientReportPeriod;
  score: ClientReportScoreFilter;
  /** `null` means all campaigns; a supplied invalid value is never coerced to null. */
  campaignId: string | null;
};

export class ClientReportFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientReportFilterError';
  }
}

type CalendarDate = {
  iso: string;
  year: number;
  month: number;
  day: number;
  dayNumber: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CUSTOM_DAYS = 366;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const MOSCOW_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: REPORT_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const MOSCOW_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: REPORT_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

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

function parseCalendarDate(value: unknown, field: 'from' | 'to'): CalendarDate {
  if (typeof value !== 'string') {
    throw new ClientReportFilterError(`${field} must be a valid date in YYYY-MM-DD format`);
  }

  const match = ISO_DATE_RE.exec(value);
  if (!match) {
    throw new ClientReportFilterError(`${field} must be a valid date in YYYY-MM-DD format`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new ClientReportFilterError(`${field} must be a valid date in YYYY-MM-DD format`);
  }

  const timestamp = utcMsForCalendarParts(year, month, day);
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    throw new ClientReportFilterError(`${field} must be a valid date in YYYY-MM-DD format`);
  }

  return { iso: value, year, month, day, dayNumber: Math.floor(timestamp / DAY_MS) };
}

function formatCalendarDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addCalendarDays(value: string, amount: number): string {
  const date = parseCalendarDate(value, 'from');
  const shifted = new Date(utcMsForCalendarParts(date.year, date.month, date.day + amount));
  return formatCalendarDate(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
  );
}

function moscowCalendarDate(date: Date): string {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new ClientReportFilterError('now must be a valid Date');
  }

  const parts = partsRecord(MOSCOW_DATE_FORMATTER, date);
  return formatCalendarDate(Number(parts.year), Number(parts.month), Number(parts.day));
}

function timeZoneOffsetMs(date: Date): number {
  const parts = partsRecord(MOSCOW_DATE_TIME_FORMATTER, date);
  const asUtc = utcMsForCalendarParts(
    Number(parts.year),
    Number(parts.month),
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const withoutMilliseconds = Math.floor(date.getTime() / 1_000) * 1_000;
  return asUtc - withoutMilliseconds;
}

/** Convert a local midnight in REPORT_TIME_ZONE into its exact UTC instant. */
function moscowMidnightUtc(value: string): Date {
  const calendar = parseCalendarDate(value, 'from');
  const localAsUtc = utcMsForCalendarParts(calendar.year, calendar.month, calendar.day);
  let candidate = localAsUtc - timeZoneOffsetMs(new Date(localAsUtc));

  // A second pass handles offset changes close to the requested boundary.
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const adjusted = localAsUtc - timeZoneOffsetMs(new Date(candidate));
    if (adjusted === candidate) break;
    candidate = adjusted;
  }

  return new Date(candidate);
}

function isPeriodPreset(value: unknown): value is ClientReportPeriodPreset {
  return (
    typeof value === 'string' &&
    (CLIENT_REPORT_PERIOD_PRESETS as readonly string[]).includes(value)
  );
}

function isScoreFilter(value: unknown): value is ClientReportScoreFilter {
  return (
    typeof value === 'string' &&
    (CLIENT_REPORT_SCORE_FILTERS as readonly string[]).includes(value)
  );
}

function resolvePeriod(
  input: ClientReportFilterInput,
  now: Date,
): ClientReportPeriod {
  if (!isPeriodPreset(input.preset)) {
    throw new ClientReportFilterError(`Unsupported period preset: ${String(input.preset)}`);
  }

  const today = moscowCalendarDate(now);
  let from: string;
  let to: string;

  switch (input.preset) {
    case 'last_7_days':
      from = addCalendarDays(today, -6);
      to = today;
      break;
    case 'last_30_days':
      from = addCalendarDays(today, -29);
      to = today;
      break;
    case 'current_month': {
      const current = parseCalendarDate(today, 'to');
      from = formatCalendarDate(current.year, current.month, 1);
      to = today;
      break;
    }
    case 'previous_month': {
      const current = parseCalendarDate(today, 'to');
      const currentMonthStart = formatCalendarDate(current.year, current.month, 1);
      to = addCalendarDays(currentMonthStart, -1);
      const previous = parseCalendarDate(to, 'to');
      from = formatCalendarDate(previous.year, previous.month, 1);
      break;
    }
    case 'custom': {
      if (input.from === undefined || input.to === undefined) {
        throw new ClientReportFilterError('Custom period requires both from and to');
      }
      const parsedFrom = parseCalendarDate(input.from, 'from');
      const parsedTo = parseCalendarDate(input.to, 'to');
      if (parsedFrom.dayNumber > parsedTo.dayNumber) {
        throw new ClientReportFilterError('from must not be after to');
      }
      const inclusiveDays = parsedTo.dayNumber - parsedFrom.dayNumber + 1;
      if (inclusiveDays > MAX_CUSTOM_DAYS) {
        throw new ClientReportFilterError(
          `Custom period cannot exceed ${MAX_CUSTOM_DAYS} days`,
        );
      }
      from = parsedFrom.iso;
      to = parsedTo.iso;
      break;
    }
  }

  return {
    preset: input.preset,
    from,
    to,
    fromUtc: moscowMidnightUtc(from),
    toExclusiveUtc: moscowMidnightUtc(addCalendarDays(to, 1)),
  };
}

function resolveCampaignId(input: ClientReportFilterInput): string | null {
  if (input.campaignId === undefined) return null;
  if (typeof input.campaignId !== 'string' || input.campaignId.trim() === '') {
    throw new ClientReportFilterError('Campaign must be a non-empty string');
  }
  return input.campaignId.trim();
}

/**
 * Resolve API/UI filter values without silently widening an invalid filter to
 * all scores, campaigns or another date preset.
 */
export function resolveClientReportFilters(
  input: ClientReportFilterInput,
  now: Date = new Date(),
): ClientReportFilters {
  if (!input || typeof input !== 'object') {
    throw new ClientReportFilterError('Report filters must be an object');
  }
  if (!isScoreFilter(input.score)) {
    throw new ClientReportFilterError(`Unsupported score filter: ${String(input.score)}`);
  }

  return {
    period: resolvePeriod(input, now),
    score: input.score,
    campaignId: resolveCampaignId(input),
  };
}

export function scoreToCode(score: number): ClientReportScoreCode {
  if (!Number.isFinite(score)) {
    throw new ClientReportFilterError('Score must be a finite number');
  }
  if (score > 1_000_000) return 'A';
  if (score >= 15_001) return 'B';
  if (score >= 1_001) return 'C';
  return 'rejected';
}

/** Normalize only; email syntax validation belongs to the validation pipeline. */
export function normalizeEmail(email: string | null | undefined): string | null {
  if (email === null || email === undefined) return null;
  const normalized = email.trim().toLowerCase();
  return normalized === '' ? null : normalized;
}

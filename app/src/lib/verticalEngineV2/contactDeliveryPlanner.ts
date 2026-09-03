const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1_000;

export type ContactDeliveryPlanDay = {
  date: string;
  quota: number;
};

export type ContactDeliveryPlan = {
  businessDate: string;
  deadline: string;
  days: ContactDeliveryPlanDay[];
  remainingContacts: number;
  plannedContacts: number;
  capacityContacts: number;
  capacityShortfall: number;
  supplyShortfall: number;
  totalShortfall: number;
};

function requireNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function parseIsoDate(value: string, label: string): number {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) {
    throw new Error(`${label} must use YYYY-MM-DD`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new Error(`${label} must be a valid calendar date`);
  }

  return Math.floor(date.getTime() / DAY_MS);
}

function formatIsoDate(dayNumber: number): string {
  return new Date(dayNumber * DAY_MS).toISOString().slice(0, 10);
}

function resolveBusinessDate(now: Date, timezone: string): string {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error('now must be a valid Date');
  }
  if (!timezone.trim()) {
    throw new Error('timezone is required');
  }

  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
  } catch {
    throw new Error(`timezone is invalid: ${timezone}`);
  }

  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get('year')}-${values.get('month')}-${values.get('day')}`;
}

export function buildContactDeliveryPlan(input: {
  now: Date;
  timezone: string;
  deadline: string;
  scheduleDays: readonly number[];
  contactsObligation: number;
  contactsDone: number;
  dailyCapacity: number;
  availableContacts: number;
  outstandingContacts?: number;
}): ContactDeliveryPlan {
  const businessDate = resolveBusinessDate(input.now, input.timezone);
  const businessDay = parseIsoDate(businessDate, 'businessDate');
  const deadlineDay = parseIsoDate(input.deadline, 'deadline');
  const scheduleDays = new Set(input.scheduleDays.map((day, index) => {
    if (!Number.isSafeInteger(day) || day < 0 || day > 6) {
      throw new Error(`scheduleDays[${index}] must be an integer from 0 through 6`);
    }
    return day;
  }));
  const contactsObligation = requireNonNegativeInteger(
    input.contactsObligation,
    'contactsObligation',
  );
  const contactsDone = requireNonNegativeInteger(input.contactsDone, 'contactsDone');
  const dailyCapacity = requireNonNegativeInteger(input.dailyCapacity, 'dailyCapacity');
  const availableContacts = requireNonNegativeInteger(
    input.availableContacts,
    'availableContacts',
  );
  const outstandingContacts = requireNonNegativeInteger(input.outstandingContacts ?? 0, 'outstandingContacts');

  const dates: string[] = [];
  for (let day = businessDay; day <= deadlineDay; day += 1) {
    const date = new Date(day * DAY_MS);
    if (scheduleDays.has(date.getUTCDay())) {
      dates.push(formatIsoDate(day));
    }
  }

  const capacityContacts = dates.length * dailyCapacity;
  if (!Number.isSafeInteger(capacityContacts)) {
    throw new Error('schedule capacity exceeds the safe integer range');
  }

  const remainingContacts = Math.max(0, contactsObligation - contactsDone);
  const capacityDeliverable = Math.min(remainingContacts, capacityContacts);
  const plannedContacts = Math.min(capacityDeliverable, availableContacts + outstandingContacts);
  // Capacity and supply are independent explanations of risk. Their overlap
  // must not be double-counted in the actual uncovered total.
  const capacityShortfall = Math.max(0, remainingContacts - capacityContacts);
  const supplyShortfall = Math.max(0, remainingContacts - availableContacts - outstandingContacts);
  // Forecast assumes each uploaded batch is first-contacted before the next
  // business day. Runtime recalculates from actual facts and pending uploads.
  let forecastRemaining = remainingContacts;
  let forecastSupply = availableContacts;
  let forecastOutstanding = outstandingContacts;
  const days = dates.map((date, index) => {
    const quota = Math.min(
      Math.ceil(forecastRemaining / (dates.length - index)),
      dailyCapacity,
      forecastSupply,
      Math.max(0, forecastRemaining - forecastOutstanding),
    );
    forecastOutstanding += quota;
    const forecastContacted = Math.min(forecastOutstanding, dailyCapacity, forecastRemaining);
    forecastOutstanding -= forecastContacted;
    forecastRemaining -= forecastContacted;
    forecastSupply -= quota;
    return { date, quota };
  });

  return {
    businessDate,
    deadline: input.deadline,
    days,
    remainingContacts,
    plannedContacts,
    capacityContacts,
    capacityShortfall,
    supplyShortfall,
    totalShortfall: remainingContacts - plannedContacts,
  };
}

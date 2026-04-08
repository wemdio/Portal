import { toIntlLocale, type Locale } from '@/lib/i18n';

const toStartOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

export const parseFlexibleDate = (value: string | null | undefined): Date | null => {
  if (!value) return null;
  const raw = value.trim();
  if (!raw) return null;

  const match = raw.match(/^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?$/);
  if (match) {
    const day = Number(match[1]);
    const month = Number(match[2]);
    if (!Number.isFinite(day) || !Number.isFinite(month)) return null;
    let year = match[3] ? Number(match[3]) : new Date().getFullYear();
    if (!Number.isFinite(year)) year = new Date().getFullYear();
    if (year < 100) year += 2000;
    const candidate = new Date(year, month - 1, day);
    if (!Number.isNaN(candidate.getTime())) return candidate;
  }

  const fallback = new Date(raw);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
};

export const formatDateLabel = (date: Date | null, locale: Locale = 'ru'): string => {
  if (!date) return '-';
  return date.toLocaleDateString(toIntlLocale(locale), { day: '2-digit', month: 'short', year: 'numeric' });
};

export const isSameMonth = (date: Date, reference: Date) =>
  date.getFullYear() === reference.getFullYear() && date.getMonth() === reference.getMonth();

export const isWithinDays = (date: Date, reference: Date, days: number) => {
  const start = toStartOfDay(reference).getTime();
  const target = toStartOfDay(date).getTime();
  const diffDays = Math.ceil((target - start) / (1000 * 60 * 60 * 24));
  return diffDays >= 0 && diffDays <= days;
};

export const isPastDate = (date: Date, reference: Date) => {
  const start = toStartOfDay(reference).getTime();
  const target = toStartOfDay(date).getTime();
  return target < start;
};

export const diffDaysFrom = (date: Date, reference: Date) => {
  const start = toStartOfDay(reference).getTime();
  const target = toStartOfDay(date).getTime();
  return Math.ceil((target - start) / (1000 * 60 * 60 * 24));
};

/**
 * Деньги календаря технички.
 *
 * Итог всегда пара «рубли и доллары», а не одно число: курса в базе нет, и
 * сложение валют по выдуманному курсу соврало бы в цифре, по которой
 * планируют расходы.
 */
import type { Currency } from '@/lib/techCalendar/types';

export interface MoneyTotals {
  RUB: number;
  USD: number;
}

export function emptyTotals(): MoneyTotals {
  return { RUB: 0, USD: 0 };
}

export function addMoney(totals: MoneyTotals, currency: Currency, amount: number): MoneyTotals {
  return { ...totals, [currency]: totals[currency] + amount };
}

const SYMBOLS: Record<Currency, string> = { RUB: '₽', USD: '$' };

export function formatMoney(amount: number, currency: Currency): string {
  const value = amount.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return currency === 'RUB' ? `${value} ${SYMBOLS.RUB}` : `${SYMBOLS.USD}${value}`;
}

/** Итог для плитки: «45 000 ₽» и «$300» двумя строками; нули не печатаем. */
export function formatTotals(totals: MoneyTotals): string[] {
  const lines: string[] = [];
  if (totals.RUB) lines.push(formatMoney(totals.RUB, 'RUB'));
  if (totals.USD) lines.push(formatMoney(totals.USD, 'USD'));
  return lines.length ? lines : [formatMoney(0, 'RUB')];
}

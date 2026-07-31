import { isValid, parseISO } from 'date-fns';
import type { NextRequest } from 'next/server';

import { GROUP_BY_VALUES, parseRange, type GroupBy } from '@/lib/expenses/period';
import {
  CATEGORY_LABELS,
  type ExpenseCategory,
  type ExpenseSource,
  type IncomeSource,
} from '@/lib/expenses/types';

/**
 * Разбор пользовательского ввода для роутов раздела «Деньги» — расходных и
 * доходных.
 *
 * Всё, что здесь бросает, роут обязан ловить и отдавать как 400: невалидный
 * ввод — это ответ пользователю, а не пятисотка в Sentry. Поэтому проверки
 * собраны в одном месте: иначе очередной роут забудет одну из них и получит
 * 500 на `?vendorId=абв` или на битом JSON.
 */

/** Значения `ExpenseSource` в рантайме. `Record<>` держит список исчерпывающим: новый источник в типе — ошибка компиляции здесь. */
const SOURCE_MAP: Record<ExpenseSource, true> = {
  tochka: true,
  tbank: true,
  brocard: true,
  manual: true,
};

/** То же для дохода: банки и только банки. */
const INCOME_SOURCE_MAP: Record<IncomeSource, true> = {
  tochka: true,
  tbank: true,
};

export const EXPENSE_SOURCES = Object.keys(SOURCE_MAP) as ExpenseSource[];
export const EXPENSE_CATEGORIES = Object.keys(CATEGORY_LABELS) as ExpenseCategory[];
export const INCOME_SOURCES = Object.keys(INCOME_SOURCE_MAP) as IncomeSource[];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export interface ExpensesQuery {
  from: string;
  to: string;
  groupBy: GroupBy;
  source: ExpenseSource | null;
  category: ExpenseCategory | null;
  vendorId: string | null;
}

/** Пустой параметр (`?source=`) — это «фильтра нет», а не «фильтр по пустой строке». */
function optional(params: URLSearchParams, name: string): string | null {
  const raw = params.get(name);
  if (raw === null) return null;
  const value = raw.trim();
  return value.length > 0 ? value : null;
}

/** Группировка ряда по времени — общая у обеих сторон раздела. */
function parseGroupBy(params: URLSearchParams): GroupBy {
  const groupBy = optional(params, 'groupBy') ?? 'day';
  if (!GROUP_BY_VALUES.includes(groupBy as GroupBy)) {
    throw new Error(`groupBy: ожидается ${GROUP_BY_VALUES.join(', ')}`);
  }
  return groupBy as GroupBy;
}

/** Разбор общей query-строки читающих роутов. Бросает `Error` с человеческим текстом. */
export function parseExpensesQuery(params: URLSearchParams): ExpensesQuery {
  const range = parseRange(params.get('from') ?? '', params.get('to') ?? '');

  const groupBy = parseGroupBy(params);

  const source = optional(params, 'source');
  if (source !== null && !EXPENSE_SOURCES.includes(source as ExpenseSource)) {
    throw new Error(`source: ожидается ${EXPENSE_SOURCES.join(', ')}`);
  }

  const category = optional(params, 'category');
  if (category !== null && !EXPENSE_CATEGORIES.includes(category as ExpenseCategory)) {
    throw new Error(`category: ожидается ${EXPENSE_CATEGORIES.join(', ')}`);
  }

  // Невалидный UUID PostgREST вернул бы ошибкой 22P02, а роут — пятисоткой.
  // Это ввод пользователя, значит 400.
  const vendorId = optional(params, 'vendorId');
  if (vendorId !== null && !isUuid(vendorId)) {
    throw new Error('vendorId: ожидается UUID');
  }

  return {
    from: range.from,
    to: range.to,
    groupBy,
    source: source as ExpenseSource | null,
    category: category as ExpenseCategory | null,
    vendorId,
  };
}

export interface IncomesQuery {
  from: string;
  to: string;
  groupBy: GroupBy;
  source: IncomeSource | null;
  /** Дрилл-даун по плательщику: ИНН и имя — разные ключи группировки, поэтому и параметра два. */
  payerInn: string | null;
  payerName: string | null;
  /** true — только выручка, false — только не-выручка, null — весь приход. */
  revenue: boolean | null;
}

const INN_RE = /^\d{10}(\d{2})?$/;
/** Имя плательщика приходит из выписки; ограничение отсекает мусор, а не длинные названия. */
const MAX_PAYER_NAME = 300;

/** Разбор query-строки доходных роутов. Бросает `Error` с человеческим текстом. */
export function parseIncomesQuery(params: URLSearchParams): IncomesQuery {
  const range = parseRange(params.get('from') ?? '', params.get('to') ?? '');

  const groupBy = parseGroupBy(params);

  const source = optional(params, 'source');
  if (source !== null && !INCOME_SOURCES.includes(source as IncomeSource)) {
    throw new Error(`source: ожидается ${INCOME_SOURCES.join(', ')}`);
  }

  // ИНН юрлица 10 цифр, ИП и физлица — 12. Проверка не про безопасность
  // (PostgREST параметризует значение), а про осмысленный 400 вместо пустого
  // ответа на опечатку.
  const payerInn = optional(params, 'payerInn');
  if (payerInn !== null && !INN_RE.test(payerInn)) {
    throw new Error('payerInn: ожидается 10 или 12 цифр');
  }

  const payerName = optional(params, 'payerName');
  if (payerName !== null && payerName.length > MAX_PAYER_NAME) {
    throw new Error(`payerName: не длиннее ${MAX_PAYER_NAME} символов`);
  }

  const revenueRaw = optional(params, 'revenue');
  if (revenueRaw !== null && revenueRaw !== 'true' && revenueRaw !== 'false') {
    throw new Error('revenue: ожидается true или false');
  }

  return {
    from: range.from,
    to: range.to,
    groupBy,
    source: source as IncomeSource | null,
    payerInn,
    payerName,
    revenue: revenueRaw === null ? null : revenueRaw === 'true',
  };
}

/** Номер страницы drill-down: неотрицательное целое. */
export function parsePage(params: URLSearchParams): number {
  const raw = optional(params, 'page');
  if (raw === null) return 0;
  const page = Number(raw);
  if (!Number.isInteger(page) || page < 0) {
    throw new Error('page: ожидается неотрицательное целое');
  }
  return page;
}

/**
 * Сегодняшняя дата по Москве.
 *
 * Витрина кладёт ручную трату в московский день (`occurred_on_msk`), а
 * `toISOString()` вернул бы день по UTC: с 00:00 до 03:00 МСК сегодняшняя
 * дата отвергалась бы как «в будущем».
 */
export function todayMsk(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
}

/** Дата ручной траты: формат, существование в календаре и не в будущем. */
export function parseOccurredOn(value: unknown): string {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value) || !isValid(parseISO(value))) {
    throw new Error('Дата в формате ГГГГ-ММ-ДД');
  }
  if (value > todayMsk()) {
    throw new Error('Дата траты в будущем');
  }
  return value;
}

/** Сумма ручной траты: положительное конечное число. */
export function parseAmount(value: unknown): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Сумма должна быть больше нуля');
  }
  return amount;
}

/** Код валюты: три буквы, как в fx_rates. */
export function parseCurrency(value: unknown): string {
  const currency = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error('Валюта — трёхбуквенный код, например RUB или USD');
  }
  return currency;
}

/** Тело запроса. Битый JSON — тоже пользовательский ввод, а не сбой сервера. */
export async function readJsonBody<T>(req: NextRequest): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new Error('Тело запроса должно быть корректным JSON');
  }
}

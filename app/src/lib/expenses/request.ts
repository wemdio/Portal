import type { NextRequest } from 'next/server';

import { GROUP_BY_VALUES, parseRange, type GroupBy } from '@/lib/expenses/period';
import { CATEGORY_LABELS, type ExpenseCategory, type ExpenseSource } from '@/lib/expenses/types';

/**
 * Разбор пользовательского ввода для роутов расходов.
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

export const EXPENSE_SOURCES = Object.keys(SOURCE_MAP) as ExpenseSource[];
export const EXPENSE_CATEGORIES = Object.keys(CATEGORY_LABELS) as ExpenseCategory[];

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

/** Разбор общей query-строки читающих роутов. Бросает `Error` с человеческим текстом. */
export function parseExpensesQuery(params: URLSearchParams): ExpensesQuery {
  const range = parseRange(params.get('from') ?? '', params.get('to') ?? '');

  const groupBy = optional(params, 'groupBy') ?? 'day';
  if (!GROUP_BY_VALUES.includes(groupBy as GroupBy)) {
    throw new Error(`groupBy: ожидается ${GROUP_BY_VALUES.join(', ')}`);
  }

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
    groupBy: groupBy as GroupBy,
    source: source as ExpenseSource | null,
    category: category as ExpenseCategory | null,
    vendorId,
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

/** Тело запроса. Битый JSON — тоже пользовательский ввод, а не сбой сервера. */
export async function readJsonBody<T>(req: NextRequest): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new Error('Тело запроса должно быть корректным JSON');
  }
}

import {
  CATEGORY_LABELS,
  UNCLASSIFIED_CATEGORY_KEY,
  UNKNOWN_EXCLUDE_REASON_KEY,
  type ExpenseCategory,
  type ExpenseSource,
  type IncomeSource,
} from '@/lib/expenses/types';

/**
 * Подписи и цвета интерфейса раздела «Деньги» — расходов и доходов.
 *
 * Живут отдельно от `types.ts`, потому что оттуда их читает и серверный код
 * (экспорт в xlsx, тексты ошибок роутов), а цвета графика ему не нужны. Здесь
 * же — единственное место, где заведены человеческие названия источников:
 * иначе они разъехались бы между фильтром, легендой графика и очередью.
 */

/** `Record` держит список исчерпывающим: новый источник в типе — ошибка компиляции здесь. */
export const SOURCE_LABELS: Record<ExpenseSource, string> = {
  tochka: 'Точка',
  tbank: 'Т-Банк',
  brocard: 'Brocard',
  manual: 'Ручные',
};

export const EXPENSE_SOURCE_VALUES = Object.keys(SOURCE_LABELS) as ExpenseSource[];
export const EXPENSE_CATEGORY_VALUES = Object.keys(CATEGORY_LABELS) as ExpenseCategory[];

/** Подпись ключа `byCategory`: там кроме категорий бывает ключ неразмеченного. */
export function categoryLabel(key: string): string {
  if (key === UNCLASSIFIED_CATEGORY_KEY) return 'Без категории';
  return CATEGORY_LABELS[key as ExpenseCategory] ?? key;
}

export function sourceLabel(key: string): string {
  return SOURCE_LABELS[key as ExpenseSource] ?? key;
}

const FALLBACK_COLOR = '#a1a1aa';

export const CATEGORY_COLORS: Record<ExpenseCategory | typeof UNCLASSIFIED_CATEGORY_KEY, string> = {
  payroll: '#0d6b57',
  marketing: '#2f7fd1',
  tools: '#8a5cd6',
  taxes: '#b4553c',
  operations: '#6b7280',
  // В график перемещения не попадают (их отбрасывает `summarize`), цвет заведён
  // для полноты — чтобы карта категорий оставалась исчерпывающей.
  transfer: '#71717a',
  other: FALLBACK_COLOR,
  [UNCLASSIFIED_CATEGORY_KEY]: '#d4a017',
};

export const SOURCE_COLORS: Record<ExpenseSource, string> = {
  tochka: '#0d6b57',
  tbank: '#d4a017',
  brocard: '#8a5cd6',
  manual: '#6b7280',
};

export function categoryColor(key: string): string {
  return CATEGORY_COLORS[key as ExpenseCategory] ?? FALLBACK_COLOR;
}

export function sourceColor(key: string): string {
  return SOURCE_COLORS[key as ExpenseSource] ?? FALLBACK_COLOR;
}

// ─── Доходы ────────────────────────────────────────────────────────────────

/**
 * Источники дохода — подмножество расходных (только банки), поэтому подпись и
 * цвет берутся из тех же карт: «Точка» на доходной вкладке обязана выглядеть
 * ровно так же, как на расходной. Отдельный `Record<IncomeSource, true>` нужен
 * не ради значений, а ради исчерпываемости: новый банк в типе — ошибка
 * компиляции здесь, а не молча пропавший пункт фильтра.
 */
const INCOME_SOURCE_MAP: Record<IncomeSource, true> = {
  tochka: true,
  tbank: true,
};

export const INCOME_SOURCE_VALUES = Object.keys(INCOME_SOURCE_MAP) as IncomeSource[];

/**
 * Подпись причины, по которой приход не считается выручкой.
 *
 * Причина — свободный текст классификатора синка («перевод себе (ИНН
 * владельца)», «банк-механика/возврат», «плательщик — банк»), он же и подпись:
 * своя таблица переводов здесь только разъехалась бы с классификатором и
 * показывала бы сырой ключ вместо причины. Заведён единственный служебный
 * ключ — для строк, у которых причины не записано.
 */
export function excludeReasonLabel(key: string): string {
  if (key === UNKNOWN_EXCLUDE_REASON_KEY) return 'Причина не записана';
  return key;
}

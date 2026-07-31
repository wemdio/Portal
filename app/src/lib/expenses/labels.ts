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

/**
 * Цвета рядов — ссылки на CSS-переменные, а не значения.
 *
 * Тёмная тема портала работает переопределением под
 * `html[data-portal-theme='dark'] .portal-shell` (см. `app/globals.css`), и до
 * хекса, зашитого в JS, она не дотягивается: пока палитра лежала здесь
 * значениями, тёмная тема рисовала график светлыми цветами. Сами значения и
 * пояснение к ним — в `globals.css`, здесь только раскладка рядов по слотам.
 *
 * Слот назначается ряду один раз и не повторяется по кругу: набор проверен на
 * различимость (в том числе при дейтеранопии), и лишний ряд, пущенный на
 * второй круг, эту проверку сломал бы молча.
 */
const SERIES_1 = 'var(--chart-series-1)';
const SERIES_2 = 'var(--chart-series-2)';
const SERIES_3 = 'var(--chart-series-3)';
const SERIES_4 = 'var(--chart-series-4)';
const SERIES_5 = 'var(--chart-series-5)';
const SERIES_6 = 'var(--chart-series-6)';

/**
 * Приглушённый нейтральный — не слот палитры, а отказ от неё.
 *
 * Им красится неразмеченное: «без категории» — не категория наравне с ФОТ и
 * налогами, а признание, что мы пока не знаем. Цветной ряд для такого не
 * годится — он назначает неизвестности идентичность. Сюда же уходят ключи,
 * которых в карте нет вовсе.
 */
const MUTED_COLOR = 'var(--chart-series-muted)';

/**
 * `transfer` в карте отсутствует намеренно: перемещения отбрасывает
 * `summarize`, в ряд по времени они не попадают по построению, и цвет им не
 * нужен. `Exclude` держит это решением, а не забывчивостью — а заодно
 * оставляет карту исчерпывающей: новая категория в типе всё так же ошибка
 * компиляции здесь.
 */
export const CATEGORY_COLORS: Record<
  Exclude<ExpenseCategory, 'transfer'> | typeof UNCLASSIFIED_CATEGORY_KEY,
  string
> = {
  payroll: SERIES_1,
  marketing: SERIES_2,
  tools: SERIES_3,
  taxes: SERIES_4,
  operations: SERIES_5,
  other: SERIES_6,
  [UNCLASSIFIED_CATEGORY_KEY]: MUTED_COLOR,
};

/** Источники — другой разрез и другой график, поэтому слоты начинаются заново. */
export const SOURCE_COLORS: Record<ExpenseSource, string> = {
  tochka: SERIES_1,
  tbank: SERIES_2,
  brocard: SERIES_3,
  manual: SERIES_4,
};

export function categoryColor(key: string): string {
  return CATEGORY_COLORS[key as keyof typeof CATEGORY_COLORS] ?? MUTED_COLOR;
}

export function sourceColor(key: string): string {
  return SOURCE_COLORS[key as ExpenseSource] ?? MUTED_COLOR;
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

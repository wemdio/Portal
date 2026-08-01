export type ExpenseSource = 'tochka' | 'tbank' | 'brocard' | 'manual';

export type ExpenseCategory =
  | 'payroll' | 'marketing' | 'tools' | 'taxes' | 'operations' | 'transfer' | 'other';

/** Категории, которые не расход, а перемещение уже учтённых денег. */
export const TRANSFER_CATEGORIES: readonly ExpenseCategory[] = ['transfer'] as const;

/** Ключ бакета в byCategory/группировках для трат без категории — тот же ключ использует график. */
export const UNCLASSIFIED_CATEGORY_KEY = 'unclassified';

export const CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  payroll: 'ФОТ',
  marketing: 'Маркетинг',
  tools: 'Сервисы и подписки',
  taxes: 'Налоги',
  operations: 'Операционка',
  transfer: 'Перемещения',
  other: 'Прочее',
};

/**
 * Вендор в выпадающем списке разметки.
 *
 * Живёт здесь, а не рядом с компонентом выбора: список собирает `ExpensesView`,
 * читает его очередь разметки и форма ручной траты, а группирует — чистая
 * функция в `vendorPicker.ts`. Тип, объявленный внутри `'use client'`-компонента,
 * втягивал бы за собой всю эту цепочку.
 *
 * `category` — обязательное поле с допустимым `null`, а не необязательное:
 * группировка по категориям без неё молча схлопывается в одну кучу «без
 * категории», и заметить это можно только глазами на живом списке.
 */
export interface VendorOption {
  id: string;
  name: string;
  category: ExpenseCategory | null;
}

/** Строка витрины expenses_v. */
export interface ExpenseRow {
  source: ExpenseSource;
  source_ref: string;
  occurred_on_msk: string;
  amount: number;
  currency: string;
  counterparty: string | null;
  counterparty_inn: string | null;
  details: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  category: ExpenseCategory | null;
  classification_method: 'rule' | 'manual' | null;
  amount_rub: number | null;
}

export interface SeriesPointBase {
  bucket: string;
  total: number;
  bySource: Record<string, number>;
  /**
   * Истина, когда календарные границы бакета (неделя/месяц) выходят за
   * пределы запрошенного периода — например первая неделя месячного отчёта,
   * начинающаяся до `from`. Данные в бакете полные для тех дней, что попали
   * в период, но столбец на графике ниже соседних не потому что расходов
   * стало меньше, а потому что в него попало меньше дней. UI помечает такой
   * столбец, а не рисует его как обычный.
   */
  partial: boolean;
}

export interface SeriesPoint extends SeriesPointBase {
  byCategory: Record<string, number>;
}

export interface ExpensesSummary {
  total: number;
  avgPerDay: number;
  deltaPrev: number | null;
  transfersTotal: number;
  unclassifiedCount: number;
  unclassifiedTotal: number;
  unconvertedCount: number;
  /** Сумма в исходной валюте (поле amount) по строкам без курса, сгруппированная по валюте. */
  unconvertedByCurrency: Record<string, number>;
  series: SeriesPoint[];
}

export interface VendorBreakdownItem {
  vendorId: string | null;
  vendorName: string;
  category: ExpenseCategory | null;
  total: number;
  ops: number;
  share: number;
  deltaPrev: number | null;
  /** Число операций этого вендора без курса ЦБ — total их не учитывает (amount_rub падает в 0), эти счётчики не дают этому потеряться. */
  unconvertedCount: number;
  unconvertedByCurrency: Record<string, number>;
}

// ─── Доходы ────────────────────────────────────────────────────────────────
//
// Доход устроен проще расхода: слоя разметки у него нет вовсе. Вместо вендоров
// и категорий работает классификатор синка — `is_revenue` плюс причина в
// `exclude_reason`. Поэтому здесь свои типы, а не расширение расходных: общий
// у сторон только денежный минимум (сумма, валюта, рублёвый эквивалент).

/**
 * Источники дохода: два банка и криптокошелёк.
 *
 * Виртуальные карты и ручные записи сюда не входят — они бывают только на
 * расходной стороне.
 */
export type IncomeSource = 'tochka' | 'tbank' | 'crypto_usdt';

/** Строка витрины incomes_v. Контрагент — плательщик. */
export interface IncomeRow {
  source: IncomeSource;
  source_ref: string;
  occurred_on_msk: string;
  amount: number;
  currency: string;
  counterparty: string | null;
  counterparty_inn: string | null;
  details: string | null;
  /** Классификатор синка: true — клиентский платёж, false — не выручка (причина в exclude_reason). */
  is_revenue: boolean | null;
  exclude_reason: string | null;
  amount_rub: number | null;
}

/** Точка ряда дохода: категорий у прихода нет, поэтому только разрез по банкам. */
export type IncomeSeriesPoint = SeriesPointBase;

/** Ключ бакета `nonRevenueByReason` для строк, у которых причина не записана. */
export const UNKNOWN_EXCLUDE_REASON_KEY = 'unknown';

export interface IncomesSummary {
  total: number;
  avgPerDay: number;
  deltaPrev: number | null;
  /** Не-выручка (is_revenue = false): в итог не входит, но показывается рядом — как перемещения в расходах. */
  nonRevenueTotal: number;
  nonRevenueCount: number;
  /**
   * Не-выручка в разрезе причин из `exclude_reason` — «возврат»,
   * «банк-механика», «перевод себе». Причина здесь ценнее самой суммы: она
   * объясняет, почему деньги пришли, но выручкой не считаются.
   */
  nonRevenueByReason: Record<string, number>;
  unconvertedCount: number;
  /** Сумма в исходной валюте (поле amount) по строкам без курса, сгруппированная по валюте. */
  unconvertedByCurrency: Record<string, number>;
  series: IncomeSeriesPoint[];
}

export interface PayerBreakdownItem {
  /**
   * Ключ группировки: `inn:<ИНН>`, если ИНН есть, иначе `name:<имя в нижнем
   * регистре>`. Пустая строка — плательщик не указан вовсе. Префикс не
   * декоративный: без него ИНН и имя из одних цифр склеились бы в одну строку.
   */
  payerKey: string;
  payerInn: string | null;
  payerName: string;
  total: number;
  ops: number;
  share: number;
  deltaPrev: number | null;
  /** См. VendorBreakdownItem: строки без курса ЦБ не должны потеряться в total. */
  unconvertedCount: number;
  unconvertedByCurrency: Record<string, number>;
}

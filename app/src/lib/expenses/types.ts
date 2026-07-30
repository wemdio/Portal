export type ExpenseSource = 'tochka' | 'tbank' | 'brocard' | 'manual';

export type ExpenseCategory =
  | 'payroll' | 'marketing' | 'tools' | 'taxes' | 'operations' | 'transfer' | 'other';

/** Категории, которые не расход, а перемещение уже учтённых денег. */
export const TRANSFER_CATEGORIES: readonly ExpenseCategory[] = ['transfer'] as const;

export const CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  payroll: 'ФОТ',
  marketing: 'Маркетинг',
  tools: 'Сервисы и подписки',
  taxes: 'Налоги',
  operations: 'Операционка',
  transfer: 'Перемещения',
  other: 'Прочее',
};

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

export interface SeriesPoint {
  bucket: string;
  total: number;
  byCategory: Record<string, number>;
  bySource: Record<string, number>;
}

export interface ExpensesSummary {
  total: number;
  avgPerDay: number;
  deltaPrev: number | null;
  transfersTotal: number;
  unclassifiedCount: number;
  unclassifiedTotal: number;
  unconvertedCount: number;
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
}

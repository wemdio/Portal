/**
 * Словарь календаря технички: значения полей и подписи к ним.
 *
 * Списки объявлены через `as const` и типы выведены из них, чтобы новый тип
 * сервиса нельзя было добавить в одном месте и забыть в другом: пропущенный
 * ключ в `SERVICE_TYPE_LABELS` — ошибка компиляции, а не пустая подпись в
 * интерфейсе.
 */

export const SERVICE_TYPES = ['proxy', 'server', 'api', 'software', 'other'] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export const SERVICE_TYPE_LABELS: Record<ServiceType, string> = {
  proxy: 'Прокси',
  server: 'Серверы',
  api: 'API',
  software: 'Софт',
  other: 'Прочее',
};

export const CURRENCIES = ['RUB', 'USD'] as const;
export type Currency = (typeof CURRENCIES)[number];

export const BILLING_CYCLES = ['monthly', 'quarterly', 'yearly'] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

export const CYCLE_LABELS: Record<BillingCycle, string> = {
  monthly: 'Ежемесячно',
  quarterly: 'Ежеквартально',
  yearly: 'Ежегодно',
};

export const TECH_STATUSES = ['active', 'pending_review', 'keep', 'cancel'] as const;
export type TechStatus = (typeof TECH_STATUSES)[number];

export const TECH_SOURCES = ['manual', 'spaceproxy'] as const;
export type TechSource = (typeof TECH_SOURCES)[number];

export const TECH_SOURCE_LABELS: Record<TechSource, string> = {
  manual: 'Вручную',
  spaceproxy: 'SpaceProxy',
};

export const TECH_BALANCE_PROVIDERS = ['serper'] as const;
export type TechBalanceProvider = (typeof TECH_BALANCE_PROVIDERS)[number];

export type TechBalanceUnit = 'credits';

export const STATUS_LABELS: Record<TechStatus, string> = {
  active: 'Активна',
  pending_review: 'Ожидает решения',
  keep: 'Оставить',
  cancel: 'Отменить',
};

export interface TechSubscription {
  id: string;
  service_name: string;
  service_type: ServiceType;
  amount: number;
  currency: Currency;
  billing_cycle: BillingCycle;
  next_billing_date: string;
  status: TechStatus;
  decision_by: string | null;
  decision_at: string | null;
  decision_notes: string | null;
  notes: string | null;
  source: TechSource;
  external_key: string | null;
  quantity: number;
  provider_status: string | null;
  synced_at: string | null;
  is_hidden: boolean;
  hidden_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TechProviderBalance {
  provider: TechBalanceProvider;
  label: string;
  balance: number | null;
  unit: TechBalanceUnit;
  synced_at: string | null;
  last_error: string | null;
  updated_at: string;
}

/** Порог жёлтого статуса в календаре. Напоминания приходят позже — см. techRenewalCron. */
export const PENDING_REVIEW_DAYS = 7;

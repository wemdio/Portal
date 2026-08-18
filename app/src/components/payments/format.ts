export const PAYMENT_DEPARTMENTS = [
  { value: 'outreach', label: 'Аутрич' },
  { value: 'paid_traffic', label: 'Платный трафик' },
  { value: 'accounting', label: 'Аккаунтинг' },
  { value: 'sales', label: 'Продажи' },
] as const;

export const PAYMENT_DEPARTMENT_LABELS = Object.fromEntries(
  PAYMENT_DEPARTMENTS.map(({ value, label }) => [value, label]),
) as Record<string, string>;

export function formatRubles(value: number): string {
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatPaymentDate(value: string | null): string {
  if (!value) return '—';
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value;
  return new Date(normalized).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

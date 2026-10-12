/**
 * Чипы списка раздела «Английские клиенты» — общий словарь сервера
 * (engAdminView.ts, роут списка) и экрана. Модуль без зависимостей: его
 * импортирует и клиентский бандл.
 */

export const HE_ENG_ADMIN_FILTERS = [
  'all',
  'waiting',
  'staff_off',
  'sending',
  'attention',
  'unverified',
  'blocked',
  'ban_no_stop',
  'blocked_leak',
] as const;
export type HeEngAdminFilter = (typeof HE_ENG_ADMIN_FILTERS)[number];

export function isHeEngAdminFilter(v: unknown): v is HeEngAdminFilter {
  return typeof v === 'string' && (HE_ENG_ADMIN_FILTERS as readonly string[]).includes(v);
}

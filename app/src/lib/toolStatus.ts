/**
 * Статусы инструментов в админской шестерёнке (см. global_tool_visibility).
 * Влияют на видимость и плашки на /tools.
 */
export type ToolStatus = 'active' | 'new' | 'beta' | 'in_development' | 'disabled';

export const TOOL_STATUSES: readonly ToolStatus[] = [
  'active',
  'new',
  'beta',
  'in_development',
  'disabled',
] as const;

export interface ToolStatusOption {
  value: ToolStatus;
  label_ru: string;
  label_en: string;
  hint_ru: string;
  hint_en: string;
}

export const TOOL_STATUS_OPTIONS: readonly ToolStatusOption[] = [
  {
    value: 'active',
    label_ru: 'Активный',
    label_en: 'Active',
    hint_ru: 'Виден всем, без плашки',
    hint_en: 'Visible to everyone, no badge',
  },
  {
    value: 'new',
    label_ru: 'Новый',
    label_en: 'New',
    hint_ru: 'Активен + плашка «Новое». Снимется автоматически через 7 дней.',
    hint_en: 'Active + “New” badge. Auto-clears after 7 days.',
  },
  {
    value: 'beta',
    label_ru: 'BETA',
    label_en: 'BETA',
    hint_ru: 'Активен + плашка «BETA». Без срока истечения.',
    hint_en: 'Active + “BETA” badge. No expiry.',
  },
  {
    value: 'in_development',
    label_ru: 'В разработке',
    label_en: 'In development',
    hint_ru: 'Серая карточка с плашкой «В разработке», некликабельна.',
    hint_en: 'Greyed-out card with “In development” badge, non-clickable.',
  },
  {
    value: 'disabled',
    label_ru: 'Отключён',
    label_en: 'Disabled',
    hint_ru: 'Скрыт у всех, включая admin. Вернуть можно только через эту модалку.',
    hint_en: 'Hidden from everyone, including admin. Re-enable from this modal.',
  },
];

const NEW_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Истёк ли статус 'new'. Возвращает true только если `newSinceIso` валиден
 * и старше 7 дней от `nowMs`.
 */
export function isNewExpired(
  newSinceIso: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!newSinceIso) return false;
  const since = new Date(newSinceIso).getTime();
  if (Number.isNaN(since)) return false;
  return nowMs - since > NEW_TTL_MS;
}

/**
 * Эффективный статус с учётом 7-дневного истечения 'new'. Если в БД
 * хранится 'new' и `new_since` старше недели — снаружи это уже 'active'.
 * Используется и сервером (`/api/user/tools`), и админской модалкой.
 */
export function effectiveToolStatus(
  status: ToolStatus,
  newSinceIso: string | null | undefined,
  nowMs: number = Date.now(),
): ToolStatus {
  if (status === 'new' && isNewExpired(newSinceIso, nowMs)) return 'active';
  return status;
}

/**
 * Дефолтный статус для инструмента без записи в global_tool_visibility —
 * выводится из хардкод-полей реестра (disabled / badge / badgeVariant).
 * Нужен чтобы admin-модалка по дефолту показывала ту же визуальную
 * картину, что юзер видит на /tools, а не плоский «Активный» для всех.
 *
 * Маппинг:
 *   disabled === true            → 'in_development'
 *   badgeVariant === 'emerald'   → 'new'    (плашка «Новое»)
 *   badgeVariant === 'amber'     → 'beta'   (плашка «BETA»)
 *   нет badge / disabled         → 'active'
 */
export function inferToolStatusFromRegistry(
  config: { disabled?: boolean; badge?: string; badgeVariant?: 'emerald' | 'amber' },
): ToolStatus {
  if (config.disabled) return 'in_development';
  if (config.badge) {
    if (config.badgeVariant === 'emerald') return 'new';
    return 'beta';
  }
  return 'active';
}

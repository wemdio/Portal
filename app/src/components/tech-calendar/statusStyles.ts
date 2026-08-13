/**
 * Цвета статусов. Те же, что в календаре почт: два календаря стоят рядом в
 * меню, и разная палитра для одинаковых по смыслу состояний читалась бы как
 * разный смысл.
 */
import type { TechStatus } from '@/lib/techCalendar/types';

export const STATUS_STYLES: Record<TechStatus, { bg: string; text: string; dot: string }> = {
  active: { bg: 'bg-blue-50', text: 'text-blue-700', dot: 'bg-blue-500' },
  pending_review: { bg: 'bg-amber-50', text: 'text-amber-700', dot: 'bg-amber-500' },
  keep: { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  cancel: { bg: 'bg-red-50', text: 'text-red-700', dot: 'bg-red-500' },
};

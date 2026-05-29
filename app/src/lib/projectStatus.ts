/**
 * Single source of truth for project-status presentation across the admin
 * portal. Replaces the per-page `STATUS_CONFIG` + `getStatusBadge` substring
 * scan, whose `Object.entries(...).find(([needle]) => key.includes(needle))`
 * was insertion-order fragile (a status containing two known substrings
 * matched whichever key was declared first).
 *
 * `tone` maps to the editorial status palette; `STATUS_TONE_VAR` resolves it
 * to the `--cp-*` custom property that both `.admin-portal` (light) and
 * `.client-portal` (dark) define, so the same dot colour works in either scope.
 */

export type StatusTone = 'green' | 'amber' | 'red' | 'neutral';

export interface StatusMeta {
  label: string;
  tone: StatusTone;
}

// Canonical statuses keyed by their normalized (trimmed, lowercased) form.
// Explicit map — exact-match first, so there is no order dependence.
const STATUS_BY_KEY: Record<string, StatusMeta> = {
  'в работе': { label: 'В работе', tone: 'green' },
  'тестирование': { label: 'Тестирование', tone: 'amber' },
  'на паузе': { label: 'На паузе', tone: 'neutral' },
  'подготовка': { label: 'Подготовка', tone: 'neutral' },
  'завершен': { label: 'Завершён', tone: 'neutral' },
  'завершён': { label: 'Завершён', tone: 'neutral' },
  completed: { label: 'Завершён', tone: 'neutral' },
  'отменен': { label: 'Отменён', tone: 'red' },
  'отменён': { label: 'Отменён', tone: 'red' },
};

/**
 * Resolve any raw status string to its label + tone. Exact canonical match
 * first; then a prioritized set of explicit substring fallbacks for free-text
 * variants (completed wins over everything, matching `isCompletedStatus`).
 */
export function resolveProjectStatus(status: string | null | undefined): StatusMeta {
  if (!status || !status.trim()) return { label: 'В работе', tone: 'green' };
  const key = status.trim().toLowerCase();

  const exact = STATUS_BY_KEY[key];
  if (exact) return exact;

  // Free-text fallbacks — explicit priority, not iteration order.
  if (key.includes('заверш') || key.includes('completed')) return { label: status, tone: 'neutral' };
  if (key.includes('отмен')) return { label: status, tone: 'red' };
  if (key.includes('пауз')) return { label: status, tone: 'neutral' };
  if (key.includes('подготов')) return { label: status, tone: 'neutral' };
  if (key.includes('тест')) return { label: status, tone: 'amber' };
  if (key.includes('работе')) return { label: status, tone: 'green' };
  return { label: status, tone: 'neutral' };
}

export function isCompletedStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  const key = status.trim().toLowerCase();
  return key.includes('заверш') || key.includes('completed');
}

/** Tone → CSS custom property for the 6px editorial status dot. */
export const STATUS_TONE_VAR: Record<StatusTone, string> = {
  green: 'var(--cp-green)',
  amber: 'var(--cp-amber)',
  red: 'var(--cp-red)',
  neutral: 'var(--cp-paper-faint)',
};

/** Общий предел RU/EN сбора: после него новые компании не начинаем. */
export const MAX_OUTREACH_RUN_MS = 6 * 60 * 60 * 1000;

export type OutreachRunStopReason = 'budget' | 'time_limit';

export function outreachRunStopReason(
  startedAt: number,
  analysisBudgetLeft: boolean,
  now = Date.now(),
): OutreachRunStopReason | null {
  if (!analysisBudgetLeft) return 'budget';
  if (now - startedAt >= MAX_OUTREACH_RUN_MS) return 'time_limit';
  return null;
}

/**
 * Перевод сервисов в «ожидает решения» за неделю до списания.
 *
 * Зовётся из двух мест: из GET списка (человек открыл экран) и из прогона
 * напоминаний (робот пришёл раньше человека). Функция идемпотентна, поэтому
 * порядок вызовов роли не играет.
 *
 * Обновление идёт по одному сервису, а не одним `update ... in (...)`:
 * желтеющих за раз — единицы, зато код остаётся на том подмножестве
 * supabase-js, которое покрыто тестовым моком, и не зависит от того, как
 * PostgREST разложит массовый фильтр.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { addDays } from '@/lib/techCalendar/dates';
import { PENDING_REVIEW_DAYS } from '@/lib/techCalendar/types';

export type TechCalendarLog = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

const defaultLog: TechCalendarLog = (level, msg, extra) => {
  if (extra !== undefined) console[level](`[tech-calendar-pending] ${msg}`, extra);
  else console[level](`[tech-calendar-pending] ${msg}`);
};

/**
 * `log` необязателен и по умолчанию пишет в console — как в
 * `runDeadlineNotifications` (см. `notifications/deadlineCron.ts`). Раньше
 * `if (error || !data?.length) return 0` делало блип PostgREST неотличимым
 * от «нечего желтить», и ошибка отдельного update терялась так же тихо —
 * с логом хотя бы видно в проде, что чинить.
 */
export async function refreshPendingReview(
  db: SupabaseClient,
  todayStr: string,
  log: TechCalendarLog = defaultLog,
): Promise<number> {
  const cutoff = addDays(todayStr, PENDING_REVIEW_DAYS);

  const { data, error } = await db
    .from('tech_subscriptions')
    .select('id')
    .eq('status', 'active')
    .lte('next_billing_date', cutoff);

  if (error) {
    log('error', `select failed: ${error.message}`);
    return 0;
  }
  if (!data?.length) return 0;

  let changed = 0;
  for (const row of data as Array<{ id: string }>) {
    const res = await db
      .from('tech_subscriptions')
      .update({ status: 'pending_review' })
      .eq('id', row.id);
    if (res.error) {
      log('error', `update failed for ${row.id}: ${res.error.message}`);
      continue;
    }
    changed += 1;
  }
  return changed;
}

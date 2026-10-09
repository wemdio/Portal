/**
 * Долговечная отметка отмены проекта: he_projects.cancelled_at
 * (supabase/migrations/20261009_0002_he_project_cancel_marker.sql).
 *
 * ЗАЧЕМ. До неё отмену помнили только строки he_jobs: роуты отмены переводят
 * активные джобы в 'cancelled', и по такой строке автоподъём и ночной проход
 * узнают, что работу остановил человек. Клиентский роут отмены с 08.10.2026
 * отвечает 200 и при НУЛЕ активных джоб (снимает автопилот, ставит паузу
 * добора, валит застрявшие базы) — такая отмена не оставляла в БД ничего, по
 * чему её можно было бы узнать позже. Отметка — одно время, «когда проект
 * последний раз остановили»; каждая отмена её переписывает.
 *
 * ПИСАТЕЛИ:
 *  - api/client/eng/projects/[id]/cancel — всегда, ОДНОЙ записью с
 *    autopilot=false (шаг 1 роута);
 *  - api/tools/hypothesis-engine/projects/[id]/cancel — только для проектов
 *    market='us' и только когда отменена хоть одна джоба (иначе роут отвечает
 *    409, как и раньше). RU-проектам staff-роут её не пишет.
 *
 * ЧИТАТЕЛИ:
 *  - he_auto_resume_transient_bases (SQL той же миграции): база, упавшая не
 *    позже отметки (updated_at <= cancelled_at), не поднимается;
 *  - ремонт осиротевшей 'collecting'-базы (baseCollectEnqueue.ts,
 *    repairHeOrphanCollectingBase): база, созданная не позже отметки, не
 *    ремонтируется, а закрывается так же, как её закрыл бы роут отмены;
 *  - baseAutoResume.ts: при включённом HE_AUTO_RESUME_TRANSIENT проверяет, что
 *    колонка есть, — иначе проход не идёт (без неё в БД стоит прежняя функция,
 *    у которой этой проверки нет);
 *  - поздний импорт сотрудника (validationRetry.ts, importHeLateConstructForBase):
 *    база, упавшая не позже отметки, не возвращается; без колонки — отказ.
 *
 * Модуль без зависимостей (только тип клиента): его тянут и роуты Next, и
 * модули воркера.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * «Колонки нет»: миграция ещё не прокатана. PostgREST отвечает на неизвестную
 * колонку в SELECT/фильтре кодом Postgres 42703, а на неизвестный ключ в теле
 * UPDATE/INSERT — своим PGRST204 («Could not find the '…' column … in the
 * schema cache»). Только эти два кода отделяют «окружение старое» от
 * настоящего сбоя БД.
 */
export function isHeMissingColumnError(error: { code?: string } | null | undefined): boolean {
  return error?.code === '42703' || error?.code === 'PGRST204';
}

export type HeProjectCancelMarker =
  /** Прочитано: рынок проекта и отметка (null — проект не отменяли). */
  | { kind: 'ok'; market: unknown; cancelledAt: string | null }
  /** Колонки нет — миграция 20261009_0002 не применена. */
  | { kind: 'unsupported' }
  /** Не прочиталось (сбой БД или строки проекта нет). */
  | { kind: 'failed'; message: string };

/** Рынок и отметка отмены проекта одним чтением. Не бросает. */
export async function readHeProjectCancelMarker(
  supabase: SupabaseClient,
  projectId: string,
): Promise<HeProjectCancelMarker> {
  try {
    const { data, error } = await supabase
      .from('he_projects')
      .select('market, cancelled_at')
      .eq('id', projectId)
      .maybeSingle();
    if (error) {
      return isHeMissingColumnError(error) ? { kind: 'unsupported' } : { kind: 'failed', message: error.message };
    }
    if (!data) return { kind: 'failed', message: `he_projects ${projectId}: not found` };
    const row = data as { market?: unknown; cancelled_at?: unknown };
    return {
      kind: 'ok',
      market: row.market,
      cancelledAt: typeof row.cancelled_at === 'string' && row.cancelled_at.length > 0 ? row.cancelled_at : null,
    };
  } catch (e) {
    return { kind: 'failed', message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Есть ли колонка отметки в этой БД. Бросает на настоящем сбое чтения:
 * вызывающий (baseAutoResume) по «неизвестно» проход не запускает.
 */
export async function heProjectCancelMarkerInstalled(supabase: SupabaseClient): Promise<boolean> {
  const { error } = await supabase.from('he_projects').select('cancelled_at').limit(1);
  if (!error) return true;
  if (isHeMissingColumnError(error)) return false;
  throw new Error(`he_projects.cancelled_at probe: ${error.message}`);
}

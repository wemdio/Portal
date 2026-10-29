import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ReactivationPool } from './reactivation';

/** Живой состав общей очереди RU перед сбором или пересборкой писем. */
export async function loadReactivationPool(db: SupabaseClient): Promise<ReactivationPool> {
  const { data, error } = await db.rpc('outreach_autofill_folder_state', { p_folder_key: 'auto_ru' });
  if (error) throw new Error(`Не прочитан состав базы автоаутрича RU: ${error.message}`);
  if (!data) return { remaining: 0, reactivation: 0 };
  const raw = data as { remaining?: unknown; reactivation_remaining?: unknown };
  const remaining = Number(raw.remaining);
  // До миграции состава очереди старая функция не знает: реактивацию не добавляем.
  const reactivation = Number(raw.reactivation_remaining ?? remaining);
  if (!Number.isFinite(remaining) || !Number.isFinite(reactivation) || remaining < 0 || reactivation < 0 || reactivation > remaining) {
    throw new Error('Не удалось определить долю реактивации в базе автоаутрича RU');
  }
  return { remaining, reactivation };
}

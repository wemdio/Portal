import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Выключатель отправки кампаний Движка вертикалей (source_kind 've2') в
 * «Рассылке» — этап 6, миграция 20261026_0020. Выключен — идущие кампании ve2
 * стоят на паузе, запустить их нельзя (здесь — для кода портала и почтовых
 * хостов; триггер в базе — страховка для старого кода).
 *
 * Нет таблицы или строки — отправка включена: почтовые хосты выкатываются
 * раньше миграций портала, и отсутствие выключателя не должно останавливать
 * отложенные запуски. Иная ошибка чтения — не знаем, значит не запускаем.
 */

export const VE2_SENDING_STOPPED_CODE = 'VE2_SENDING_STOPPED';

export type Ve2SendingSwitch =
  | { state: 'enabled' }
  | { state: 'stopped'; changedAt: string | null }
  | { state: 'unknown'; error: string };

function missingRelation(error: { code?: string; message?: string }): boolean {
  return error.code === '42P01' || error.code === 'PGRST205' || /does not exist|Could not find the table/i.test(error.message ?? '');
}

export async function readVe2SendingSwitch(db: SupabaseClient): Promise<Ve2SendingSwitch> {
  try {
    const { data, error } = await db.from('ve_sender_global_settings')
      .select('sending_enabled, sending_changed_at').eq('id', true).maybeSingle();
    if (error) return missingRelation(error) ? { state: 'enabled' } : { state: 'unknown', error: error.message };
    const row = data as { sending_enabled?: boolean | null; sending_changed_at?: string | null } | null;
    return row?.sending_enabled === false ? { state: 'stopped', changedAt: row.sending_changed_at ?? null } : { state: 'enabled' };
  } catch (error) {
    return { state: 'unknown', error: error instanceof Error ? error.message : String(error) };
  }
}

/** Отказ запуска кампании Движка по выключателю: null — запускать можно. */
export function ve2SendingRefusal(read: Ve2SendingSwitch): null | { status: number; code?: string; message: string } {
  if (read.state === 'enabled') return null;
  if (read.state === 'stopped') {
    return {
      status: 409,
      code: VE2_SENDING_STOPPED_CODE,
      message: 'Отправка кампаний Движка остановлена администратором — запуск недоступен',
    };
  }
  return { status: 503, message: 'Не удалось проверить выключатель отправки кампаний Движка — повторите' };
}

import { supabaseAdmin } from '@/lib/supabaseAdmin';

export interface BenchRequestLog {
  keyId: string;
  tool: string | null;
  action: string;
  statusCode: number;
  rowsReturned: number;
  durationMs: number;
}

/**
 * Журнал обращений — метаданные и ничего больше.
 *
 * Тела запросов сюда не пишутся намеренно: в них приходят базы клиентов, и
 * журнал превратился бы в копилку чужих персональных данных без всякой нужды.
 * Для разбора инцидента достаточно знать, кто, что и когда дёргал и сколько
 * строк унёс.
 *
 * Запись не должна ронять запрос: обращение уже обслужено, и падение журнала
 * не повод отдавать пользователю ошибку. Поэтому глотаем молча.
 */
export async function logBenchRequest(entry: BenchRequestLog): Promise<void> {
  if (!supabaseAdmin) return;
  try {
    await supabaseAdmin.from('bench_api_requests').insert({
      key_id: entry.keyId,
      tool: entry.tool,
      action: entry.action,
      status_code: entry.statusCode,
      rows_returned: entry.rowsReturned,
      duration_ms: entry.durationMs,
    });
    await supabaseAdmin
      .from('bench_api_keys')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', entry.keyId);
  } catch {
    // намеренно молча — см. комментарий выше
  }
}

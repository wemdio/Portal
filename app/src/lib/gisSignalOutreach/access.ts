import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';

/**
 * Доступ к дашборду «2GIS + сигналы». Дашборд виден ровно ОДНОМУ клиенту —
 * тому, чей profiles.id записан в синглтон-строке конфига пайплайна
 * (gis_signal_pipeline_config, id=1, колонка client_user_id).
 *
 * Хелпер разделяют API-роут (/api/client/gis-signals[/enabled]) и
 * server-component страницы (/client/gis-signals), чтобы правило гейта
 * жило в одном месте. Существование дашборда не афишируем: чужим — 404.
 */

/** client_user_id из конфига или null (конфига нет / колонка пустая / БД недоступна). */
export async function getGisSignalsClientUserId(): Promise<string | null> {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin
    .from('gis_signal_pipeline_config')
    .select('client_user_id')
    .eq('id', 1)
    .maybeSingle();
  if (error || !data) return null;
  const id = (data as { client_user_id?: string | null }).client_user_id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** true, если userId — тот самый клиент из конфига пайплайна. */
export async function isGisSignalsClient(userId: string): Promise<boolean> {
  const clientId = await getGisSignalsClientUserId();
  return clientId !== null && clientId === userId;
}

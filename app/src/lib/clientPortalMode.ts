import 'server-only';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { ClientNavMode } from '@/lib/clientNav';

/**
 * Режим клиентского кабинета, вычисленный на сервере.
 *
 * Тот же предикат, что отдаёт GET /api/client/portal-mode для навигации:
 * 'auto' только когда СОВПАЛИ оба флага — `profiles.auto_pipeline_enabled` и
 * `client_auto_pipeline_configs.enabled`. Рассинхрон админских флагов трактуем
 * как 'manual' (менее привилегированный режим).
 *
 * Отдельная функция нужна, потому что режим спрашивает уже не только
 * навигация: серверные роуты (например, отчёт по кампаниям) решают по нему,
 * показывать ли метрики открытий. Держим предикат в одном месте, чтобы UI и
 * API не разъехались.
 */
export async function resolveClientPortalMode(userId: string): Promise<ClientNavMode> {
  if (!supabaseAdmin) return 'manual';

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('auto_pipeline_enabled')
    .eq('id', userId)
    .maybeSingle();

  if (!(profile as { auto_pipeline_enabled?: boolean } | null)?.auto_pipeline_enabled) {
    return 'manual';
  }

  const { data: config } = await supabaseAdmin
    .from('client_auto_pipeline_configs')
    .select('enabled')
    .eq('client_user_id', userId)
    .maybeSingle();

  return (config as { enabled?: boolean } | null)?.enabled ? 'auto' : 'manual';
}

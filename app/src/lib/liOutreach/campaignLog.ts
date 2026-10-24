import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Запись в журнал кампании (вкладка «Логи») о действии человека: настройки,
 * базы, аккаунты. События воркера пишет сам воркер. Ошибка записи журнала
 * никогда не ломает само действие.
 */
export async function logCampaignEvent(
  db: SupabaseClient,
  campaignId: string | null | undefined,
  level: 'info' | 'warning' | 'error',
  message: string,
  actor?: string | null,
): Promise<void> {
  if (!campaignId) return;
  try {
    const { error } = await db.from('li_campaign_logs').insert({
      campaign_id: campaignId,
      level,
      message: actor ? `${message} (${actor})` : message,
    });
    if (error) console.warn('[li-outreach] campaign log insert failed:', error.message);
  } catch (e) {
    console.warn('[li-outreach] campaign log insert threw:', e);
  }
}

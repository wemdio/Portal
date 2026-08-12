/**
 * Запись в журнал кампании из мест вне воркера.
 *
 * Журнал на вкладке «Логи» до сих пор вёл только воркер, и половина истории в
 * него не попадала: всё, что оператор делает руками через интерфейс, случалось
 * бесследно. Для передачи лида это особенно плохо — между нажатием кнопки и
 * уходом сообщения проходят часы, и без записей нельзя ответить даже на вопрос
 * «её вообще ставили в очередь?».
 *
 * Ошибку записи глотаем: журнал — это рассказ о работе, а не сама работа.
 * Уронить постановку передачи из-за того, что не удалось записать строку о
 * ней, было бы обменом ценного на служебное.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type CampaignLogLevel = 'info' | 'warning' | 'error';

export async function logCampaign(
  db: SupabaseClient,
  campaignId: string,
  level: CampaignLogLevel,
  message: string,
): Promise<void> {
  try {
    await db.from('tg_outreach_logs').insert({ campaign_id: campaignId, level, message });
  } catch {
    /* журнал не должен ломать то, о чём рассказывает */
  }
}

/** Как называть вид передачи в журнале и в интерфейсе. */
export function forwardKindLabel(kind: string): string {
  return kind === 'partner' ? 'кандидат в партнёры' : 'лид';
}

/** Кого передаём — в одну строку для журнала. */
export function forwardWho(username: string | null, tgUserId: number | null): string {
  const clean = (username ?? '').trim().replace(/^@/, '');
  if (clean) return `@${clean}`;
  return tgUserId ? `ID ${tgUserId}` : 'без юзернейма';
}

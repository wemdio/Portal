import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Черновики «Рассылки», созданные попыткой запуска VE2 (source_kind 've2',
 * source_job_id = резервирование запуска), — найти и убрать, если запуск не
 * состоялся. Без campaignOps и server-only: модуль подключают маршрут сверки
 * запуска и сам запуск.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Черновики попытки запуска. Ошибка чтения — исключение: «нет» нельзя путать с «не прочитали». */
export async function readVeSenderReservationCampaigns(
  db: SupabaseClient,
  reservationId: string,
): Promise<Array<{ id: string; status: string }>> {
  if (!UUID_RE.test(reservationId)) return [];
  const { data, error } = await db.from('sender_campaigns')
    .select('id, status').eq('source_kind', 've2').eq('source_job_id', reservationId);
  if (error) throw new Error(`черновики «Рассылки» не прочитаны: ${error.message}`);
  return ((data ?? []) as Array<{ id: string; status: string }>).map((row) => ({ id: String(row.id), status: String(row.status) }));
}

/** Какие из этих id — кампании «Рассылки» (не Instantly). */
export async function findSenderCampaignIds(db: SupabaseClient, ids: readonly string[]): Promise<string[]> {
  const uuids = [...new Set(ids.filter((id) => UUID_RE.test(id)))];
  if (!uuids.length) return [];
  const { data, error } = await db.from('sender_campaigns').select('id').in('id', uuids);
  if (error) throw new Error(`кампании «Рассылки» не прочитаны: ${error.message}`);
  return ((data ?? []) as Array<{ id: string }>).map((row) => String(row.id));
}

/**
 * Убрать черновики несостоявшейся попытки запуска: привязку к проекту, затем
 * саму кампанию — по одной, только без получателей (черновик или
 * поставленная на паузу через API: без получателей она ничего не слала). Если запуск уже
 * записан в очередь (finalize дошёл), не трогаем ничего: на эти кампании
 * ссылаются строки очереди. remaining — сколько кампаний попытки осталось;
 * ok — не осталось ни одной. Повтор безопасен.
 */
export async function rollbackVeSenderReservation(
  db: SupabaseClient,
  reservationId: string,
): Promise<{ ok: boolean; deleted: number; remaining: number }> {
  if (!UUID_RE.test(reservationId)) return { ok: true, deleted: 0, remaining: 0 };
  const campaigns = await readVeSenderReservationCampaigns(db, reservationId);
  if (!campaigns.length) return { ok: true, deleted: 0, remaining: 0 };
  const { data: queued, error: queueError } = await db.from('ve_launch_queue_items')
    .select('id').eq('prepare_reservation_id', reservationId).limit(1);
  if (queueError) throw new Error(`очередь запуска не прочитана: ${queueError.message}`);
  if ((queued ?? []).length) return { ok: false, deleted: 0, remaining: campaigns.length };
  let deleted = 0;
  for (const campaign of campaigns) {
    if (campaign.status !== 'draft' && campaign.status !== 'paused') continue;
    const { count, error: countError } = await db.from('sender_recipients')
      .select('id', { count: 'exact', head: true }).eq('campaign_id', campaign.id);
    if (countError) throw new Error(`получатели черновика не прочитаны: ${countError.message}`);
    if (count !== 0) continue;
    const { error: unlinkError } = await db.from('project_sender_campaigns').delete().eq('campaign_id', campaign.id);
    if (unlinkError) throw new Error(`привязка черновика не снята: ${unlinkError.message}`);
    const { data: removed, error: deleteError } = await db.from('sender_campaigns').delete()
      .eq('id', campaign.id).eq('source_kind', 've2').in('status', ['draft', 'paused']).select('id');
    if (deleteError) throw new Error(`черновик не удалён: ${deleteError.message}`);
    if ((removed ?? []).length) deleted += 1;
  }
  const remaining = campaigns.length - deleted;
  return { ok: remaining === 0, deleted, remaining };
}

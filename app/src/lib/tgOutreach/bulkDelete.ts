/**
 * Разбор тела запроса на массовое удаление сущностей кампании.
 *
 * Вынесено из роутов, потому что правило одно на всех и его легко потерять при
 * копипасте: удалять можно только внутри одной кампании. Роут всегда добавляет
 * `.eq('campaign_id', campaignId)` к `.in('id', ids)` — без этого чужой id,
 * подставленный в запрос, снёс бы строку из соседней кампании.
 */

/** Больше за раз не принимаем: защита от случайного «удалить всё» по кривому клиенту. */
export const BULK_DELETE_MAX_IDS = 500;

export type BulkDeleteRequest =
  | { ok: true; campaignId: string; ids: string[] }
  | { ok: false; error: string };

export function parseBulkDeleteBody(body: unknown): BulkDeleteRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Неверный JSON' };
  }

  const raw = body as Record<string, unknown>;

  const campaignId = typeof raw.campaign_id === 'string' ? raw.campaign_id.trim() : '';
  if (!campaignId) return { ok: false, error: 'campaign_id обязателен' };

  if (!Array.isArray(raw.ids)) {
    return { ok: false, error: 'ids должен быть непустым массивом' };
  }

  const ids = Array.from(
    new Set(
      raw.ids
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  );

  if (ids.length === 0) return { ok: false, error: 'ids должен быть непустым массивом' };
  if (ids.length > BULK_DELETE_MAX_IDS) {
    return { ok: false, error: `За один раз можно удалить не больше ${BULK_DELETE_MAX_IDS} записей` };
  }

  return { ok: true, campaignId, ids };
}

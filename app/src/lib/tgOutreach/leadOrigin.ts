/**
 * Откуда пришёл контакт: оффер (имя базы) и чат-источник.
 *
 * В диалоге связи с загруженным контактом нет — она восстанавливается по
 * юзернейму среди баз кампании. Нужна и ручной передаче, и автоматической,
 * поэтому живёт отдельно от той и другой.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { usernameKey, sourceChatOf } from './report';

export interface LeadOrigin {
  baseName: string | null;
  sourceChat: string | null;
}

const EMPTY: LeadOrigin = { baseName: null, sourceChat: null };

export async function loadLeadOrigin(
  db: SupabaseClient,
  campaignId: string,
  username: string | null,
): Promise<LeadOrigin> {
  const key = usernameKey(username);
  if (!key) return EMPTY;

  const { data: baseRows } = await db
    .from('tg_outreach_bases')
    .select('id, name')
    .eq('campaign_id', campaignId)
    .limit(500);
  const bases = (baseRows ?? []) as Array<{ id: string; name: string }>;
  if (!bases.length) return EMPTY;

  const { data: contactRows } = await db
    .from('tg_outreach_base_contacts')
    .select('base_id, username, raw')
    .in('base_id', bases.map((b) => b.id))
    .limit(50_000);
  const contact = ((contactRows ?? []) as Array<{
    base_id: string; username: string; raw: Record<string, unknown> | null;
  }>).find((c) => usernameKey(c.username) === key);
  if (!contact) return EMPTY;

  return {
    baseName: bases.find((b) => b.id === contact.base_id)?.name ?? null,
    // Та же функция, что считает «обработанные чаты» в отчёте: карточка
    // менеджеру и цифра клиенту должны понимать источник одинаково.
    sourceChat: sourceChatOf(contact.raw) || null,
  };
}

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Добавить в рассылку кампании людей её рассылаемой базы (`li_campaigns.lead_list_id`),
 * которых там ещё нет.
 *
 * Раньше это делала только кнопка «Запустить»: дозагруженные в базу идущей кампании
 * люди и новая выбранная база ждали перезапуска. Теперь то же самое делает и воркер на
 * каждом тике — и при старте, и потом.
 *
 * Только вставка недостающих пар (ignoreDuplicates): уже идущих лидов не трогаем, иначе
 * их шаг откатится к нулю и им уйдёт второй инвайт (буря `already_invited`, апрель 2026).
 */
export async function enrollActiveBase(db: SupabaseClient, campaignId: string): Promise<number> {
  const { data: campaign } = await db.from('li_campaigns').select('lead_list_id').eq('id', campaignId).maybeSingle();
  const listId = (campaign as { lead_list_id?: string | null } | null)?.lead_list_id;
  if (!listId) return 0;

  // PostgREST отдаёт не больше тысячи строк за запрос — читаем страницами.
  const readAll = async (
    query: (from: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
  ): Promise<string[]> => {
    const ids: string[] = [];
    for (let from = 0; from < 100_000; from += 1000) {
      const { data, error } = await query(from);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Array<{ id?: string; lead_id?: string }>;
      ids.push(...rows.map((r) => String(r.id ?? r.lead_id)));
      if (rows.length < 1000) break;
    }
    return ids;
  };

  const [leadIds, enrolledIds] = await Promise.all([
    readAll((from) => db.from('li_leads').select('id').eq('lead_list_id', listId).order('id').range(from, from + 999)),
    readAll((from) => db.from('li_campaign_leads').select('lead_id').eq('campaign_id', campaignId).order('lead_id').range(from, from + 999)),
  ]);
  const enrolled = new Set(enrolledIds);
  const missing = leadIds.filter((id) => !enrolled.has(id));

  for (let i = 0; i < missing.length; i += 500) {
    const { error } = await db.from('li_campaign_leads').upsert(
      missing.slice(i, i + 500).map((leadId) => ({ campaign_id: campaignId, lead_id: leadId, current_step: 0, status: 'pending' })),
      { onConflict: 'campaign_id,lead_id', ignoreDuplicates: true },
    );
    if (error) throw new Error(error.message);
  }
  return missing.length;
}

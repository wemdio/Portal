import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Очередь баз кампании: когда рассылаемая база закончилась, кампания переходит
 * к следующей по `li_lead_lists.queue_position`.
 *
 * База закончилась, если в ней есть люди, все они уже в рассылке кампании и ни
 * у кого нет статуса pending / in_progress / waiting. Лид, ждущий следующего
 * шага цепочки, считается незавершённым. Пустая база не закончилась — в неё
 * могут ещё лить.
 */

interface QueueList {
  id: string;
  name: string;
}

async function count(query: PromiseLike<{ count: number | null; error: { message: string } | null }>): Promise<number> {
  const { count: n, error } = await query;
  if (error) throw new Error(error.message);
  return n ?? 0;
}

/** Людей в базе. */
const leadsIn = (db: SupabaseClient, listId: string) =>
  count(db.from('li_leads').select('id', { count: 'exact', head: true }).eq('lead_list_id', listId));

/** Сколько людей базы уже в рассылке кампании (опционально — только с этими статусами). */
const enrolledIn = (db: SupabaseClient, campaignId: string, listId: string, statuses?: string[]) => {
  let query = db
    .from('li_campaign_leads')
    .select('id, li_leads!inner(lead_list_id)', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .eq('li_leads.lead_list_id', listId);
  if (statuses) query = query.in('status', statuses);
  return count(query);
};

/**
 * Переключает `lead_list_id` кампании на следующую базу очереди, если текущая
 * закончилась (или рассылаемой базы нет). Возвращает новую базу или null.
 */
export async function advanceBaseQueue(db: SupabaseClient, campaignId: string): Promise<QueueList | null> {
  const [{ data: campaign }, { data: lists }] = await Promise.all([
    db.from('li_campaigns').select('lead_list_id').eq('id', campaignId).maybeSingle(),
    db
      .from('li_lead_lists')
      .select('id, name')
      .eq('campaign_id', campaignId)
      .order('queue_position', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true }),
  ]);
  const queue = (lists ?? []) as QueueList[];
  if (!queue.length) return null;

  const currentId = (campaign as { lead_list_id?: string | null } | null)?.lead_list_id ?? null;
  const currentIndex = currentId ? queue.findIndex((list) => list.id === currentId) : -1;
  // Рассылаемая база не из очереди этой кампании — выбрана вручную, не трогаем.
  if (currentId && currentIndex < 0) return null;

  if (currentId) {
    const total = await leadsIn(db, currentId);
    if (total === 0) return null;
    const enrolled = await enrolledIn(db, campaignId, currentId);
    if (enrolled < total) return null;
    const unfinished = await enrolledIn(db, campaignId, currentId, ['pending', 'in_progress', 'waiting']);
    if (unfinished > 0) return null;
  }

  for (const candidate of queue.slice(currentIndex + 1)) {
    if ((await leadsIn(db, candidate.id)) === 0) continue;
    const { error } = await db.from('li_campaigns').update({ lead_list_id: candidate.id }).eq('id', campaignId);
    if (error) throw new Error(error.message);
    return candidate;
  }
  return null;
}

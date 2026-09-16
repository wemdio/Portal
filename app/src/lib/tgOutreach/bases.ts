/**
 * Валидация списка рассыльщиков базы.
 *
 * Используется роутами создания и правки базы: список приходит из чекбоксов
 * интерфейса, но доверять ему нельзя — id мог протухнуть (аккаунт удалили,
 * скопировали из другой кампании). Чужие id не ругаются, а молча выкидываются:
 * сохранение из интерфейса их прислать не может, а ручной запрос лечить
 * диалогом смысла нет — результат тот же, что оператор убрал галочку.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function sanitizeSendingAccountIds(
  db: SupabaseClient,
  campaignId: string,
  raw: unknown,
): Promise<string[]> {
  if (!Array.isArray(raw)) return [];
  const candidates = [...new Set(raw.filter((v): v is string => typeof v === 'string' && UUID_RE.test(v)))];
  if (!candidates.length) return [];

  const { data: accounts } = await db
    .from('tg_outreach_accounts')
    .select('id')
    .eq('campaign_id', campaignId)
    .in('id', candidates);
  return ((accounts ?? []) as Array<{ id: string }>).map((a) => a.id);
}

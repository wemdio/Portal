// Re-export generic auth/error helpers used by all tools.
// These are tool-agnostic despite living under tgOutreach/.
export { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';

import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function checkIsAdmin(userId: string): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const { data } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .maybeSingle();
  return data?.role === 'admin';
}

/**
 * Resolve a display name for each user_id. Used to label cross-specialist
 * campaigns/accounts in the LI-outreach UI ("владелец: Имя") now that every
 * specialist sees everyone's launches. Falls back full_name → email → 'Без имени'.
 * Returns an empty map (never throws) if the admin client is missing.
 */
export async function fetchOwnerNames(
  userIds: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!supabaseAdmin) return map;
  const ids = [...new Set(userIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return map;
  const { data } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, email')
    .in('id', ids);
  for (const p of data ?? []) {
    const row = p as { id: string; full_name: string | null; email: string | null };
    map.set(row.id, row.full_name || row.email || 'Без имени');
  }
  return map;
}

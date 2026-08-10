import type { SupabaseClient } from '@supabase/supabase-js';

export const TEAM_ACCESS_CAPABILITY = 'can_access_team' as const;

export type TeamAccessCheck =
  | { allowed: boolean; error: null }
  | { allowed: false; error: unknown };

export async function checkTeamAccess(
  client: Pick<SupabaseClient, 'rpc'>,
): Promise<TeamAccessCheck> {
  try {
    const { data, error } = await client.rpc(TEAM_ACCESS_CAPABILITY);
    if (error) return { allowed: false, error };
    return { allowed: data === true, error: null };
  } catch (error) {
    return { allowed: false, error };
  }
}

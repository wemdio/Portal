import type { SupabaseClient } from '@supabase/supabase-js';

export const TEAM_ACCESS_CAPABILITY = 'can_access_team' as const;
export const TEAM_REVIEW_REQUEST_SUBMIT_CAPABILITY =
  'can_submit_team_review_request' as const;
export const TEAM_REVIEW_REQUEST_SHARED_VIEW_CAPABILITY =
  'can_view_team_review_requests_shared' as const;

export type TeamAccessCheck =
  | { allowed: boolean; error: null }
  | { allowed: false; error: unknown };

export async function checkTeamCapability(
  client: Pick<SupabaseClient, 'rpc'>,
  capability: string,
): Promise<TeamAccessCheck> {
  try {
    const { data, error } = await client.rpc(capability);
    if (error) return { allowed: false, error };
    return { allowed: data === true, error: null };
  } catch (error) {
    return { allowed: false, error };
  }
}

export function checkTeamAccess(
  client: Pick<SupabaseClient, 'rpc'>,
): Promise<TeamAccessCheck> {
  return checkTeamCapability(client, TEAM_ACCESS_CAPABILITY);
}

export function checkTeamReviewRequestSubmitAccess(
  client: Pick<SupabaseClient, 'rpc'>,
): Promise<TeamAccessCheck> {
  return checkTeamCapability(client, TEAM_REVIEW_REQUEST_SUBMIT_CAPABILITY);
}

export function checkTeamReviewRequestSharedViewAccess(
  client: Pick<SupabaseClient, 'rpc'>,
): Promise<TeamAccessCheck> {
  return checkTeamCapability(
    client,
    TEAM_REVIEW_REQUEST_SHARED_VIEW_CAPABILITY,
  );
}

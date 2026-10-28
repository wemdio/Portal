import type { SupabaseClient } from '@supabase/supabase-js';
import { readHeProjectOwner } from './letterBrandGuard';
import { heEngUnverifiedSiteEmail, type HeEngCollectionRow } from './engCollectionTarget';
import { heLaunchEmailStrength, heLaunchEmailVerdict } from './launchHandoff';

/** ENG client policy only; neither a US staff project nor an unreadable owner opts in. */
export async function readHeEngEmailPolicy(
  db: SupabaseClient,
  project: { market?: unknown; created_by?: unknown },
): Promise<boolean> {
  if (project.market !== 'us') return false;
  const owner = await readHeProjectOwner(db, project.created_by);
  if (owner.kind === 'unknown') {
    throw new Error('ENG email policy: project owner could not be read', { cause: owner.error });
  }
  return owner.kind === 'eng_client';
}

/** Keep checked OK/catch-all addresses; stable OK-first order before any limit. */
export function selectHeEngEmailRows<T extends { _email_status?: unknown }>(rows: readonly T[]): T[] {
  const policy = { allowCatchAll: true };
  return rows
    .filter((row) => heLaunchEmailVerdict(row._email_status, policy) === 'accepted')
    .sort((a, b) => heLaunchEmailStrength(b._email_status, policy) - heLaunchEmailStrength(a._email_status, policy));
}

/** ok 3, catch-all 2, an unverified address from the company's own site 1, anything else 0 (not kept). */
function heEngCollectRank(status: unknown, row: HeEngCollectionRow): number {
  const policy = { allowCatchAll: true };
  if (heLaunchEmailVerdict(status, policy) === 'accepted') return heLaunchEmailStrength(status, policy);
  return heEngUnverifiedSiteEmail(status, row) ? 1 : 0;
}

/**
 * What a collection keeps for an ENG client: the checked addresses of
 * selectHeEngEmailRows and, after them, unverified addresses from the company's
 * own site (heEngUnverifiedSiteEmail). Stable order before any limit. Sending
 * and the client's counts still go by selectHeEngEmailRows.
 */
export function selectHeEngCollectRows<T>(items: readonly T[], view: (item: T) => { status: unknown; row: HeEngCollectionRow }): T[] {
  return items
    .map((item) => { const { status, row } = view(item); return { item, rank: heEngCollectRank(status, row) }; })
    .filter(({ rank }) => rank > 0)
    .sort((a, b) => b.rank - a.rank)
    .map(({ item }) => item);
}

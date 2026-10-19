import type { SupabaseClient } from '@supabase/supabase-js';
import { readHeProjectOwner } from './letterBrandGuard';
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

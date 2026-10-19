import type { SupabaseClient } from '@supabase/supabase-js';
import { readHeProjectOwner } from './letterBrandGuard';

/**
 * ENG cabinet: collect and check the audience before writing its letters.
 * A US market alone does not identify a client project: staff/legacy and RU
 * keep their existing chain-first flow. An unreadable owner is not a reason
 * to fall back to a paid draft generation.
 */
export async function readHeEngBaseFirst(
  db: SupabaseClient,
  project: { market?: unknown; created_by?: unknown },
): Promise<boolean> {
  if (project.market !== 'us') return false;
  const owner = await readHeProjectOwner(db, project.created_by);
  if (owner.kind === 'unknown') {
    throw new Error('ENG preparation: project owner could not be read', { cause: owner.error });
  }
  return owner.kind === 'eng_client';
}

import type { SupabaseClient } from '@supabase/supabase-js';
import { readHeEngEmailPolicy } from './engEmailPolicy';
import type { HeEngCollectionScope } from './engCollectionQueue';
import type { HeJob } from './types';

/** Only ordinary, budgeted ENG client collections may share a worker slot. */
export async function readHeEngCollectionScope(
  db: SupabaseClient,
  job: HeJob,
): Promise<HeEngCollectionScope> {
  const serial: HeEngCollectionScope = {
    id: job.id, project_id: job.project_id, baseId: null, verticalId: null, parallelEligible: false,
  };
  if (job.stage !== 'base_collect' || job.payload?.refill === true ||
      typeof job.payload?.base_id !== 'string' || !job.payload.base_id) return serial;
  const { data: project, error: projectError } = await db.from('he_projects')
    .select('market, created_by').eq('id', job.project_id).maybeSingle();
  if (projectError) throw new Error(`ENG collection scope: project read failed: ${projectError.message}`);
  if (!project || !(await readHeEngEmailPolicy(db, project))) return serial;
  // Read the small policy marker, never the potentially large collection checkpoint.
  const { data: base, error: baseError } = await db.from('he_bases')
    .select('id, project_id, vertical_id, source, status, collect_info->eng_base_budget_version')
    .eq('id', job.payload.base_id).eq('project_id', job.project_id).maybeSingle();
  if (baseError) throw new Error(`ENG collection scope: base read failed: ${baseError.message}`);
  if (!base || base.source !== 'auto' || base.status !== 'collecting' ||
      base.eng_base_budget_version !== 1 || typeof base.vertical_id !== 'string' || !base.vertical_id) return serial;
  return { ...serial, baseId: base.id, verticalId: base.vertical_id, parallelEligible: true };
}

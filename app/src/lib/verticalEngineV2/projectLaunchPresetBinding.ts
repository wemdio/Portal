import type { SupabaseClient } from '@supabase/supabase-js';

const BINDING_COLUMNS =
  'id, launch_preset_id, launch_instantly_account_id, launch_preset_bound_at, launch_preset_bound_by';

interface ProjectBindingRow {
  id: string;
  launch_preset_id: string | null;
  launch_instantly_account_id: string | null;
  launch_preset_bound_at: string | null;
  launch_preset_bound_by: string | null;
}

export interface VeProjectLaunchPresetBinding {
  launch_preset_id: string;
  launch_instantly_account_id: string;
  launch_preset_bound_at: string;
  launch_preset_bound_by: string;
}

export type VeProjectLaunchPresetBindingResult =
  | {
      status: 'bound';
      newlyBound: boolean;
      binding: VeProjectLaunchPresetBinding;
    }
  | {
      status: 'mismatch' | 'workspace_changed';
      binding: VeProjectLaunchPresetBinding;
    }
  | { status: 'project_not_found' }
  | { status: 'error'; error: string };

export interface EnsureVeProjectLaunchPresetBindingInput {
  projectId: string;
  /** Preset already loaded and validated from its live source. */
  livePresetId: string;
  /** Canonical workspace from that same live preset read. */
  liveInstantlyAccountId: string;
  boundBy: string;
  now?: Date;
}

type ClassifiedBinding =
  | { state: 'unbound' }
  | {
      state: 'bound' | 'mismatch' | 'workspace_changed';
      binding: VeProjectLaunchPresetBinding;
    }
  | { state: 'error'; error: string };

function classifyBinding(
  row: ProjectBindingRow,
  livePresetId: string,
  liveInstantlyAccountId: string,
): ClassifiedBinding {
  const values = [
    row.launch_preset_id,
    row.launch_instantly_account_id,
    row.launch_preset_bound_at,
    row.launch_preset_bound_by,
  ];
  if (values.every((value) => value == null)) return { state: 'unbound' };

  if (values.some((value) => typeof value !== 'string' || value.trim().length === 0)) {
    return { state: 'error', error: 'Project launch preset binding is incomplete' };
  }

  const binding: VeProjectLaunchPresetBinding = {
    launch_preset_id: row.launch_preset_id as string,
    launch_instantly_account_id: (row.launch_instantly_account_id as string).trim(),
    launch_preset_bound_at: row.launch_preset_bound_at as string,
    launch_preset_bound_by: row.launch_preset_bound_by as string,
  };
  if (binding.launch_preset_id !== livePresetId) {
    return { state: 'mismatch', binding };
  }
  if (binding.launch_instantly_account_id !== liveInstantlyAccountId) {
    return { state: 'workspace_changed', binding };
  }
  return { state: 'bound', binding };
}

function resultFromClassified(
  classified: Exclude<ClassifiedBinding, { state: 'unbound' }>,
  newlyBound = false,
): VeProjectLaunchPresetBindingResult {
  if (classified.state === 'error') {
    return { status: 'error', error: classified.error };
  }
  if (classified.state === 'bound') {
    return { status: 'bound', newlyBound, binding: classified.binding };
  }
  return { status: classified.state, binding: classified.binding };
}

async function readProjectBinding(
  db: SupabaseClient,
  projectId: string,
): Promise<
  | { status: 'found'; row: ProjectBindingRow }
  | { status: 'project_not_found' }
  | { status: 'error'; error: string }
> {
  const { data, error } = await db
    .from('ve_projects')
    .select(BINDING_COLUMNS)
    .eq('id', projectId)
    .maybeSingle();
  if (error) return { status: 'error', error: error.message };
  if (!data) return { status: 'project_not_found' };
  return { status: 'found', row: data as ProjectBindingRow };
}

/**
 * Validate an existing project binding or establish the first one with a
 * compare-and-set update. A lost first-binding race is always reread and
 * classified against the same live preset/workspace instead of being retried.
 */
export async function ensureVeProjectLaunchPresetBinding(
  db: SupabaseClient,
  input: EnsureVeProjectLaunchPresetBindingInput,
): Promise<VeProjectLaunchPresetBindingResult> {
  const projectId = input.projectId.trim();
  const livePresetId = input.livePresetId.trim();
  const liveInstantlyAccountId = input.liveInstantlyAccountId.trim();
  const boundBy = input.boundBy.trim();
  if (!projectId || !livePresetId || !liveInstantlyAccountId || !boundBy) {
    return { status: 'error', error: 'Project launch preset binding input is incomplete' };
  }

  const firstRead = await readProjectBinding(db, projectId);
  if (firstRead.status !== 'found') return firstRead;
  const initial = classifyBinding(firstRead.row, livePresetId, liveInstantlyAccountId);
  if (initial.state !== 'unbound') return resultFromClassified(initial);

  const boundAt = (input.now ?? new Date()).toISOString();
  const { data: changed, error: updateError } = await db
    .from('ve_projects')
    .update({
      launch_preset_id: livePresetId,
      launch_instantly_account_id: liveInstantlyAccountId,
      launch_preset_bound_at: boundAt,
      launch_preset_bound_by: boundBy,
    })
    .eq('id', projectId)
    .is('launch_preset_id', null)
    .is('launch_instantly_account_id', null)
    .is('launch_preset_bound_at', null)
    .is('launch_preset_bound_by', null)
    .select(BINDING_COLUMNS)
    .maybeSingle();
  if (updateError) return { status: 'error', error: updateError.message };

  if (changed) {
    const classified = classifyBinding(
      changed as ProjectBindingRow,
      livePresetId,
      liveInstantlyAccountId,
    );
    if (classified.state === 'unbound') {
      return { status: 'error', error: 'Project launch preset binding was not persisted' };
    }
    return resultFromClassified(classified, classified.state === 'bound');
  }

  const latestRead = await readProjectBinding(db, projectId);
  if (latestRead.status !== 'found') return latestRead;
  const latest = classifyBinding(latestRead.row, livePresetId, liveInstantlyAccountId);
  if (latest.state === 'unbound') {
    return { status: 'error', error: 'Project launch preset binding race was not resolved' };
  }
  return resultFromClassified(latest);
}
